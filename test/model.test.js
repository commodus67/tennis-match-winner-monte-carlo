import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  DEFAULT_UNRANKED_POINTS,
} from '../src/model.js';

test('effectiveStrength falls back to the unranked floor for missing/zero/invalid points', () => {
  assert.equal(effectiveStrength(1500), 1500);
  assert.equal(effectiveStrength(null), DEFAULT_UNRANKED_POINTS);
  assert.equal(effectiveStrength(undefined), DEFAULT_UNRANKED_POINTS);
  assert.equal(effectiveStrength(0), DEFAULT_UNRANKED_POINTS);
  assert.equal(effectiveStrength(NaN), DEFAULT_UNRANKED_POINTS);
  assert.equal(effectiveStrength(500, 300), 500);
  assert.equal(effectiveStrength(null, 300), 300);
});

test('bradleyTerryProb is 0.5 for equal strengths, favors the higher one otherwise, and is symmetric', () => {
  assert.equal(bradleyTerryProb(1000, 1000, 1), 0.5);
  assert.ok(bradleyTerryProb(2000, 1000, 1) > 0.5);
  const pA = bradleyTerryProb(2000, 1000, 1);
  const pB = bradleyTerryProb(1000, 2000, 1);
  assert.ok(Math.abs(pA + pB - 1) < 1e-12);
});

test('blendUncertainty pulls toward 0.5 and clamps uncertainty to [0,1]', () => {
  assert.equal(blendUncertainty(0.9, 0), 0.9);
  assert.equal(blendUncertainty(0.9, 1), 0.5);
  assert.ok(Math.abs(blendUncertainty(0.9, 0.5) - 0.7) < 1e-9);
  // out-of-range uncertainty is clamped, not left to blow up the blend
  assert.equal(blendUncertainty(0.9, -1), 0.9);
  assert.equal(blendUncertainty(0.9, 5), 0.5);
});

test('preMatchProbability: calibration sanity check against 5 live KXATPMATCH markets (24 sep 2026)', () => {
  // See model.js header for the full writeup. k=1.0, u=0.15 (the defaults)
  // should land within ~15 points of the vig-free market price on 4 of the
  // 5 pairs; the 5th (Borges/Ugo Carabelli) is a known, documented outlier
  // ranking points alone can't see (surface/form/H2H) — assert it's merely
  // bounded, not close, so a future recalibration doesn't silently regress
  // the other four without anyone noticing.
  const cases = [
    { pa: 1565, pb: 745, market: 0.624, label: 'Tabilo vs Mannarino' },
    { pa: 700, pb: 1930, market: 0.2894, label: 'Hijikata vs Rublev' },
    { pa: 763, pb: 683, market: 0.548, label: 'Brooksby vs Sonego' },
    { pa: 871, pb: 634, market: 0.6515, label: 'Faria vs Gaston' },
  ];
  for (const { pa, pb, market, label } of cases) {
    const p = preMatchProbability(pa, pb);
    assert.ok(Math.abs(p - market) < 0.15, `${label}: model ${p.toFixed(3)} vs market ${market} — expected within 0.15`);
  }
  // the documented outlier: assert it's a real number in (0,1) and on the
  // correct side of 0.5 (model still favors the higher-ranked player),
  // without asserting closeness to the market's 0.816.
  const outlier = preMatchProbability(1095, 770);
  assert.ok(outlier > 0.5 && outlier < 1);
});

test('matchWinProbability: pSet=0.5 gives a 50/50 match regardless of format, from 0-0', () => {
  assert.equal(matchWinProbability(0.5, 2, 0, 0), 0.5);
  assert.equal(matchWinProbability(0.5, 3, 0, 0), 0.5);
});

test('matchWinProbability: already having won the match returns 1, already lost returns 0', () => {
  assert.equal(matchWinProbability(0.5, 2, 2, 0), 1);
  assert.equal(matchWinProbability(0.5, 2, 0, 2), 0);
  assert.equal(matchWinProbability(0.9, 3, 3, 1), 1);
});

test('matchWinProbability: being up a set raises win probability over the pre-match number', () => {
  const pre = matchWinProbability(0.6, 2, 0, 0);
  const upOne = matchWinProbability(0.6, 2, 1, 0);
  const downOne = matchWinProbability(0.6, 2, 0, 1);
  assert.ok(upOne > pre);
  assert.ok(downOne < pre);
});

test('setProbFromMatchProb round-trips through matchWinProbability for both formats', () => {
  for (const target of [0.55, 0.6, 0.75, 0.816, 0.9, 0.95]) {
    for (const setsToWin of [2, 3]) {
      const pSet = setProbFromMatchProb(target, setsToWin);
      const back = matchWinProbability(pSet, setsToWin, 0, 0);
      assert.ok(Math.abs(back - target) < 1e-6, `setsToWin=${setsToWin} target=${target} back=${back}`);
    }
  }
});

test('setProbFromMatchProb: best-of-5 needs a smaller per-set edge than best-of-3 for the same match probability', () => {
  // longer formats let a smaller favorite reassert itself over more sets,
  // so the per-set probability needed to reach a given match probability
  // should be smaller (closer to 0.5) for best-of-5 than best-of-3.
  const target = 0.8;
  const pSetBo3 = setProbFromMatchProb(target, 2);
  const pSetBo5 = setProbFromMatchProb(target, 3);
  assert.ok(pSetBo5 < pSetBo3);
});

test('simulateRemainingSets: deterministic with a seeded rng, and roughly matches the closed-form probability', () => {
  const rng = makeRng(42);
  const iterations = 40000;
  const sim = simulateRemainingSets(0.65, 2, 0, 0, iterations, rng);
  const closedForm = matchWinProbability(0.65, 2, 0, 0);
  assert.ok(Math.abs(sim.winProbA - closedForm) < 0.02, `sim ${sim.winProbA} vs closed-form ${closedForm}`);
  // reproducibility: same seed, same result
  const sim2 = simulateRemainingSets(0.65, 2, 0, 0, iterations, makeRng(42));
  assert.equal(sim.winProbA, sim2.winProbA);
});

test('projectMatch: a match that has not started uses the closed-form pre-match number directly', () => {
  const result = projectMatch({ pointsA: 2000, pointsB: 1000, setsToWin: 2, iterations: 5000 });
  assert.equal(result.method, 'pre-match');
  assert.equal(result.setsDistribution, null);
  assert.equal(result.winProbA, result.preMatchProbA);
});

test('projectMatch: a live match simulates from the current set score and favors the player already ahead', () => {
  const evenPre = projectMatch({ pointsA: 1000, pointsB: 1000, setsToWin: 2, iterations: 30000 });
  const upOne = projectMatch({
    pointsA: 1000,
    pointsB: 1000,
    setsToWin: 2,
    setsWonA: 1,
    setsWonB: 0,
    iterations: 30000,
  });
  assert.equal(upOne.method, 'live-simulation');
  assert.ok(upOne.winProbA > evenPre.winProbA);
  assert.ok(upOne.setsDistribution && Object.keys(upOne.setsDistribution).length > 0);
});

test('setsToWinFor: best-of-5 only for ATP men\'s Grand Slams, best-of-3 for everything else including WTA Slams', () => {
  assert.equal(setsToWinFor('atp', 'Wimbledon'), 3);
  assert.equal(setsToWinFor('atp', 'US Open'), 3);
  assert.equal(setsToWinFor('atp', 'Australian Open'), 3);
  assert.equal(setsToWinFor('atp', 'Roland Garros'), 3);
  assert.equal(setsToWinFor('atp', 'Chengdu Open'), 2);
  assert.equal(setsToWinFor('atp', 'AITO Hangzhou Open'), 2);
  assert.equal(setsToWinFor('wta', 'Wimbledon'), 2);
  assert.equal(setsToWinFor('wta', 'US Open'), 2);
});
