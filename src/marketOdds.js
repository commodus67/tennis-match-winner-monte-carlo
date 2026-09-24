// Kalshi match-winner markets (KXATPMATCH / KXWTAMATCH) + edge/sizing.
//
// Reused as-is from the MLB/NHL/NBA marketOdds.js pattern (see
// [[marketodds-modulo]]): the Kalshi fee model (feePerContract/kalshiFee),
// the fractional-Kelly position sizing shape (bankroll /
// maxPerPositionPct / maxTotalExposurePct), and the exclusive-vs-independent
// market distinction. Tennis match-winner markets are two INDEPENDENT
// binary contracts per match (mutually_exclusive: true at the event level,
// but each side is its own market) — same shape NBA/NHL treat as
// independent, not the "N contracts summing to a fixed target" shape used
// for e.g. division winners.
//
// NOT reused: the team ALIASES/NORMALIZED_ALIASES table. That table (and
// its bug — see [[marketodds-modulo]]) is inherently team-sport-specific.
// Tennis markets carry the player's full name verbatim in `yes_sub_title`
// (verified 24 sep 2026: "Nuno Borges", "Roman Safiullin", etc. — the same
// strings ESPN gives as athlete.displayName), so instead of a hand-maintained
// alias dictionary this file normalizes BOTH sides at match time — the same
// "normalize once, use everywhere" lesson the alias bug taught, applied by
// construction instead of by a lookup table that can itself go unnormalized.

const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';

/** Strip diacritics/punctuation and lowercase, so "Núñez" / "NUNEZ" / "nunez" all match. */
function normalizePlayerName(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Order-invariant token set for a name, e.g. "yi zhou". Needed because ESPN
 * and Kalshi don't always agree on name order for the same player: ESPN
 * gives Yi Zhou's athlete.displayName as "Zhou Yi" (surname-first, per his
 * own firstName/lastName fields) while Kalshi's yes_sub_title has "Yi Zhou"
 * (Western order) — verified 24 sep 2026, real live match. A plain string
 * match, or a last-word-only fallback, both fail on this pair (the "last
 * word" is a different token on each side). Comparing sorted token sets
 * fixes it without a hand-maintained name-order table.
 */
function nameTokenKey(name) {
  return normalizePlayerName(name).split(' ').filter(Boolean).sort().join(' ');
}

async function fetchKalshiMarkets(seriesTicker) {
  const markets = [];
  let cursor = '';
  do {
    const url = `${KALSHI_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Kalshi request failed: ${res.status} ${res.statusText} for ${url}`);
    }
    const data = await res.json();
    markets.push(...(data.markets || []));
    cursor = data.cursor || '';
  } while (cursor);
  return markets;
}

/** Parse Kalshi's string dollar fields ("0.6100") into numbers; null-safe. */
function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find the Kalshi market whose yes_sub_title matches this player's name.
 * Tries, in order: (1) exact normalized string match, (2) order-invariant
 * token-set match (handles ESPN vs Kalshi disagreeing on name-word order),
 * (3) last-token-only match, only when exactly one candidate market shares
 * that token (the same last-resort tier the old team ALIASES matcher used).
 * Returns null rather than guessing when nothing matches unambiguously —
 * an unmatched player just means no market comparison for that row, not a
 * wrong one.
 */
function matchPlayerToMarket(displayName, markets) {
  const target = normalizePlayerName(displayName);
  if (!target) return null;

  const exact = markets.find((m) => normalizePlayerName(m.yes_sub_title) === target);
  if (exact) return exact;

  const targetKey = nameTokenKey(displayName);
  const tokenMatch = markets.find((m) => nameTokenKey(m.yes_sub_title) === targetKey);
  if (tokenMatch) return tokenMatch;

  const lastToken = target.split(' ').pop();
  const candidates = markets.filter((m) => normalizePlayerName(m.yes_sub_title).split(' ').pop() === lastToken);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Build a { yesBid, yesAsk, noBid, noAsk, ticker, openInterest, volume } quote from a raw Kalshi market object. */
function quoteFromMarket(market) {
  if (!market) return null;
  return {
    ticker: market.ticker,
    yesBid: toNum(market.yes_bid_dollars),
    yesAsk: toNum(market.yes_ask_dollars),
    noBid: toNum(market.no_bid_dollars),
    noAsk: toNum(market.no_ask_dollars),
    openInterest: toNum(market.open_interest_fp),
    volume: toNum(market.volume_fp),
  };
}

/**
 * Kalshi's per-contract taker fee: rate * p * (1-p), no rounding at this
 * stage (rounding happens once, at the order level, in kalshiFee). rate
 * 0.07 is the taker rate; a maker order pays roughly a quarter of that
 * (Kalshi's 0.0175 maker rate) — pass feeRate explicitly to model that.
 */
function feePerContract(price, rate = 0.07) {
  return rate * price * (1 - price);
}

/**
 * Total fee for an order of `contracts` contracts at `price`, rounded the
 * way Kalshi actually rounds: sum the per-contract fee across all
 * contracts, clear float dust, THEN ceiling to the cent — once per ORDER,
 * not once per contract (ceiling-per-contract overcharges).
 */
function kalshiFee(price, contracts, rate = 0.07) {
  const raw = feePerContract(price, rate) * contracts;
  const cleaned = Math.round(raw * 1e6) / 1e6;
  return Math.ceil(cleaned * 100) / 100;
}

/**
 * Fractional-Kelly stake as a fraction of bankroll for a binary contract
 * priced at `price` (0-1, cost per $1 of payout) when the true probability
 * is `p`. Standard Kelly f* = p - (1-p)/b where b = (1-price)/price;
 * `kellyFractionMultiplier` scales it down (e.g. 0.5 = half-Kelly) for
 * conservative sizing — matches the "sizing conservador para principiante"
 * pattern from [[tennis-event-contracts]] (1-2% per position, few open
 * positions at once).
 */
function kellyFraction(p, price, kellyFractionMultiplier = 0.5) {
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price;
  const f = p - (1 - p) / b;
  return Math.max(0, f) * kellyFractionMultiplier;
}

/**
 * Evaluate both sides (YES and NO) of a single match's contract for one
 * player and keep whichever has the better fee-adjusted edge — mirrors
 * buildValueBets in the team-sport Actors, which does the same "check both
 * sides" pass rather than assuming YES is always the way to express an edge.
 */
function evaluateContract(modelProb, quote, feeRate) {
  const yesEdge = quote.yesAsk == null ? -Infinity : modelProb - quote.yesAsk - feePerContract(quote.yesAsk, feeRate);
  const noModelProb = 1 - modelProb;
  const noEdge = quote.noAsk == null ? -Infinity : noModelProb - quote.noAsk - feePerContract(quote.noAsk, feeRate);
  if (yesEdge >= noEdge) {
    return { side: 'YES', price: quote.yesAsk, sideModelProb: modelProb, edge: yesEdge };
  }
  return { side: 'NO', price: quote.noAsk, sideModelProb: noModelProb, edge: noEdge };
}

/**
 * Turn a list of { modelProb, quote, ...passthrough } rows into value-bet
 * rows with edge, verdict (VALUE/WATCH/SKIP) and a suggested Kelly stake,
 * capped by maxPerPositionPct and, in aggregate across all VALUE rows,
 * by maxTotalExposurePct — same two-tier cap as the team-sport Actors.
 * `edgeThreshold` default 0.05 matches the beginner-conservative default
 * in [[tennis-event-contracts]] (tennis-live-predictor v2).
 */
function buildValueBets(rows, opts = {}) {
  const {
    feeRate = 0.07,
    edgeThreshold = 0.05,
    bankroll = 0,
    maxPerPositionPct = 0.02,
    maxTotalExposurePct = 0.2,
    kellyFractionMultiplier = 0.5,
    minMarketOpenInterest = 0,
  } = opts;

  const evaluated = rows.map((row) => {
    if (!row.quote || row.quote.yesAsk == null || row.quote.noAsk == null) {
      return { ...row, side: null, price: null, edge: null, verdict: 'NO_MARKET', kellyFraction: 0, suggestedStake: null };
    }
    if ((row.quote.openInterest || 0) < minMarketOpenInterest) {
      return { ...row, side: null, price: null, edge: null, verdict: 'ILLIQUID', kellyFraction: 0, suggestedStake: null };
    }
    const best = evaluateContract(row.modelProb, row.quote, feeRate);
    const kelly = kellyFraction(best.sideModelProb, best.price, kellyFractionMultiplier);
    const positionCap = bankroll * maxPerPositionPct;
    const uncappedStake = bankroll * kelly;
    const stake = Math.min(uncappedStake, positionCap);
    return {
      ...row,
      side: best.side,
      price: best.price,
      edge: best.edge,
      verdict: best.edge >= edgeThreshold ? 'VALUE' : 'WATCH',
      kellyFraction: kelly,
      suggestedStake: bankroll > 0 ? Math.round(stake * 100) / 100 : null,
    };
  });

  if (bankroll > 0) {
    const totalCap = bankroll * maxTotalExposurePct;
    let used = 0;
    const byEdgeDesc = evaluated.filter((r) => r.verdict === 'VALUE').sort((a, b) => b.edge - a.edge);
    for (const row of byEdgeDesc) {
      const remaining = Math.max(0, totalCap - used);
      const capped = Math.min(row.suggestedStake || 0, remaining);
      row.suggestedStake = Math.round(capped * 100) / 100;
      used += capped;
    }
  }

  return evaluated;
}

export {
  KALSHI_BASE,
  normalizePlayerName,
  nameTokenKey,
  fetchKalshiMarkets,
  matchPlayerToMarket,
  quoteFromMarket,
  feePerContract,
  kalshiFee,
  kellyFraction,
  evaluateContract,
  buildValueBets,
};
