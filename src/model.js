// Pure Monte Carlo tennis match-win model. No network, no Apify SDK — kept
// separate from main.js so it can be unit tested in isolation (same
// discipline as model.js in the NBA/NHL Actors).
//
// METHOD (documented once here, referenced from README):
//
// 1. STRENGTH: each player's strength is their live ATP/WTA ranking points
//    (site.api.espn.com .../rankings). Points are a continuously-updated,
//    tour-wide, apples-to-apples strength signal — unlike team sports we
//    have no "season standings" to fall back on, so there is no preseason
//    honesty gate here; the closest analogue is players with NO ranking
//    (qualifiers, wildcards, players outside the top `rankingsDepth`), who
//    get a configurable low-end floor (`unrankedPoints`) instead of being
//    dropped.
//
// 2. PRE-MATCH PROBABILITY: a Bradley-Terry model on ranking points,
//        pRaw(A beats B) = pointsA^k / (pointsA^k + pointsB^k)
//    with exponent k = `rankingSensitivity`. Calibrated 24 Sep 2026 against
//    5 live, liquid KXATPMATCH markets where BOTH players had a current ATP
//    ranking (Tabilo/Mannarino, Hijikata/Rublev, Brooksby/Sonego,
//    Faria/Gaston, Borges/Ugo Carabelli): k=1.0 (plain ranking-points ratio)
//    minimized mean absolute error (0.080) against the vig-free market
//    price, only marginally ahead of k=0.8-0.9 (~0.08) on a small sample.
//    One pair (Borges/Ugo Carabelli) was a 23-point outlier the whole k
//    sweep couldn't close — ranking points don't see surface form, H2H or
//    injuries, which is exactly what `strengthUncertainty` exists to hedge
//    against. Revisit this fit once more paired live data has accumulated
//    (log actual vs. Kalshi in [[tennis-decisions]]-style bookkeeping).
//
// 3. UNCERTAINTY BLEND: same honesty device as NBA (`strengthUncertainty`
//    0.22) and NHL — blend the raw Bradley-Terry probability toward a
//    coin-flip by `strengthUncertainty` (default 0.15, a bit lower than the
//    team-sport actors because ranking points are a same-week, single
//    signal rather than a full-season point differential):
//        p = pRaw * (1 - u) + 0.5 * u
//
// 4. SET FORMAT: best-of-3 everywhere except men's Grand Slams (best-of-5).
//    Callers pass `setsToWin` (2 or 3); see espn.js for how it's derived
//    from the tournament name.
//
// 5. LIVE STATE: if the match has already started, the pre-match
//    probability alone is stale. We invert it to an equivalent
//    PER-SET win probability (the constant p such that an iid best-of-N
//    sequence of Bernoulli(p) sets reproduces the pre-match probability),
//    then Monte Carlo-simulate only the sets that remain, seeded with the
//    sets each player has already won. This keeps the model responsive to
//    the score without needing point-by-point data (which ESPN doesn't
//    expose) — the same "one clean signal, simulate forward" spirit as the
//    other Actors' game-by-game season simulation.

const DEFAULT_RANKING_SENSITIVITY = 1.0;
const DEFAULT_STRENGTH_UNCERTAINTY = 0.15;
const DEFAULT_UNRANKED_POINTS = 200; // below rank ~150 (~370-500 pts); a deliberate low floor, not a guess at a real ranking
const DEFAULT_ITERATIONS = 20000;

/**
 * Simple splitmix32 PRNG so simulations are reproducible in tests without
 * pulling in a dependency. Not cryptographic; not meant to be.
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
}

/** Effective strength for a player: their ranking points, or the floor if unranked. */
function effectiveStrength(points, unrankedPoints = DEFAULT_UNRANKED_POINTS) {
  if (typeof points !== 'number' || !Number.isFinite(points) || points <= 0) {
    return unrankedPoints;
  }
  return points;
}

/** Raw Bradley-Terry probability that player A beats player B, before the uncertainty blend. */
function bradleyTerryProb(strengthA, strengthB, k = DEFAULT_RANKING_SENSITIVITY) {
  const a = Math.pow(strengthA, k);
  const b = Math.pow(strengthB, k);
  if (a + b === 0) return 0.5;
  return a / (a + b);
}

/** Blend a raw probability toward 0.5 by `uncertainty` (0 = trust the model fully, 1 = coin flip). */
function blendUncertainty(pRaw, uncertainty = DEFAULT_STRENGTH_UNCERTAINTY) {
  const u = Math.min(Math.max(uncertainty, 0), 1);
  return pRaw * (1 - u) + 0.5 * u;
}

/**
 * Pre-match win probability for player A from ranking points alone
 * (Bradley-Terry + uncertainty blend). This is the number that gets
 * inverted to a per-set probability for live simulation.
 */
function preMatchProbability(pointsA, pointsB, opts = {}) {
  const {
    rankingSensitivity = DEFAULT_RANKING_SENSITIVITY,
    strengthUncertainty = DEFAULT_STRENGTH_UNCERTAINTY,
    unrankedPoints = DEFAULT_UNRANKED_POINTS,
  } = opts;
  const sA = effectiveStrength(pointsA, unrankedPoints);
  const sB = effectiveStrength(pointsB, unrankedPoints);
  const pRaw = bradleyTerryProb(sA, sB, rankingSensitivity);
  return blendUncertainty(pRaw, strengthUncertainty);
}

/**
 * Closed-form probability that player A wins a best-of-(2*setsToWin-1)
 * match, given A wins each independent set with probability pSet, and the
 * match currently stands at setsWonA-setsWonB (0-0 for a match that hasn't
 * started). Uses the negative-binomial "race to setsToWin" formula rather
 * than Monte Carlo, so it's exact and fast — used to invert pre-match
 * probability into a per-set probability (see setProbFromMatchProb).
 */
function matchWinProbability(pSet, setsToWin, setsWonA = 0, setsWonB = 0) {
  if (setsWonA >= setsToWin) return 1;
  if (setsWonB >= setsToWin) return 0;
  const remA = setsToWin - setsWonA; // sets A still needs
  const remB = setsToWin - setsWonB; // sets B still needs
  const q = 1 - pSet;
  // P(A reaches remA wins before B reaches remB wins), both racing on iid
  // Bernoulli(pSet) trials: sum over the number of sets B wins (j = 0..remB-1)
  // before A completes remA sets, i.e. a negative binomial tail.
  let p = 0;
  for (let j = 0; j < remB; j += 1) {
    p += binomialCoefficient(remA - 1 + j, j) * Math.pow(pSet, remA) * Math.pow(q, j);
  }
  return p;
}

function binomialCoefficient(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * Invert matchWinProbability: find the per-set probability pSet such that
 * an iid best-of-(2*setsToWin-1) match (0-0) gives the target match
 * probability. Monotonic in pSet, so plain bisection is exact enough
 * (well under 1e-9 after 60 iterations) without needing a closed form.
 */
function setProbFromMatchProb(pMatch, setsToWin) {
  if (pMatch <= 0) return 0;
  if (pMatch >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const f = matchWinProbability(mid, setsToWin, 0, 0);
    if (f < pMatch) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Monte Carlo-simulate the sets remaining in a match from the current
 * state, each won independently with probability pSet by player A.
 * Returns { winProbA, winProbB, setsDistribution } where setsDistribution
 * maps total-sets-played (from the CURRENT state onward, i.e. remaining
 * sets in this call) to how often that many were needed.
 */
function simulateRemainingSets(pSet, setsToWin, setsWonA, setsWonB, iterations, rng) {
  let winsA = 0;
  const setsPlayedCounts = new Map();
  for (let i = 0; i < iterations; i += 1) {
    let a = setsWonA;
    let b = setsWonB;
    let played = 0;
    while (a < setsToWin && b < setsToWin) {
      played += 1;
      if (rng() < pSet) a += 1;
      else b += 1;
    }
    if (a >= setsToWin) winsA += 1;
    setsPlayedCounts.set(played, (setsPlayedCounts.get(played) || 0) + 1);
  }
  const setsDistribution = {};
  for (const [played, count] of setsPlayedCounts) {
    setsDistribution[played] = count / iterations;
  }
  return {
    winProbA: winsA / iterations,
    winProbB: 1 - winsA / iterations,
    setsDistribution,
  };
}

/**
 * Top-level entry point: given both players' ranking points, the match
 * format, and the current live state (defaults to a match that hasn't
 * started), returns a full Monte Carlo projection for player A.
 *
 * @param {object} params
 * @param {number} params.pointsA - player A's current ranking points
 * @param {number} params.pointsB - player B's current ranking points
 * @param {number} [params.setsToWin=2] - 2 for best-of-3, 3 for best-of-5
 * @param {number} [params.setsWonA=0]
 * @param {number} [params.setsWonB=0]
 * @param {number} [params.iterations=20000]
 * @param {number} [params.rankingSensitivity]
 * @param {number} [params.strengthUncertainty]
 * @param {number} [params.unrankedPoints]
 * @param {function} [params.rng] - injectable PRNG (tests pass a seeded one)
 */
function projectMatch(params) {
  const {
    pointsA,
    pointsB,
    setsToWin = 2,
    setsWonA = 0,
    setsWonB = 0,
    iterations = DEFAULT_ITERATIONS,
    rankingSensitivity = DEFAULT_RANKING_SENSITIVITY,
    strengthUncertainty = DEFAULT_STRENGTH_UNCERTAINTY,
    unrankedPoints = DEFAULT_UNRANKED_POINTS,
    rng = makeRng(0xc0ffee ^ (iterations * 2654435761)),
  } = params;

  const preMatchProbA = preMatchProbability(pointsA, pointsB, {
    rankingSensitivity,
    strengthUncertainty,
    unrankedPoints,
  });

  // If the match hasn't started, the pre-match probability IS the
  // projection (no need to round-trip through set inversion + simulation,
  // though we still report the equivalent per-set probability for
  // transparency in the output).
  const pSet = setProbFromMatchProb(preMatchProbA, setsToWin);

  if (setsWonA === 0 && setsWonB === 0) {
    return {
      preMatchProbA,
      pSet,
      winProbA: preMatchProbA,
      winProbB: 1 - preMatchProbA,
      setsDistribution: null, // not simulated; closed-form pre-match number used directly
      method: 'pre-match',
    };
  }

  const sim = simulateRemainingSets(pSet, setsToWin, setsWonA, setsWonB, iterations, rng);
  return {
    preMatchProbA,
    pSet,
    winProbA: sim.winProbA,
    winProbB: sim.winProbB,
    setsDistribution: sim.setsDistribution,
    method: 'live-simulation',
  };
}

/**
 * A men's Grand Slam is best-of-5; everything else (ATP tour-level, and
 * ALL WTA events including women's Slams) is best-of-3. There is no
 * reliable per-match "format" field from ESPN (it reports periods:5 even
 * for best-of-3 ATP 250 matches), so this is a deliberate lookup against
 * the 4 majors rather than trusting that field. Match on tournament name
 * containing any of these (case-insensitive) AND league === 'atp'.
 */
const MENS_SLAMS = ['australian open', 'french open', 'roland garros', 'wimbledon', 'us open'];

function setsToWinFor(league, tournamentName) {
  const name = (tournamentName || '').toLowerCase();
  const isMensSlam = league === 'atp' && MENS_SLAMS.some((slam) => name.includes(slam));
  return isMensSlam ? 3 : 2;
}

export {
  makeRng,
  effectiveStrength,
  bradleyTerryProb,
  blendUncertainty,
  preMatchProbability,
  matchWinProbability,
  setProbFromMatchProb,
  simulateRemainingSets,
  projectMatch,
  setsToWinFor,
  MENS_SLAMS,
  DEFAULT_RANKING_SENSITIVITY,
  DEFAULT_STRENGTH_UNCERTAINTY,
  DEFAULT_UNRANKED_POINTS,
  DEFAULT_ITERATIONS,
};
