import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePlayerName,
  nameTokenKey,
  matchPlayerToMarket,
  quoteFromMarket,
  feePerContract,
  kalshiFee,
  kellyFraction,
  evaluateContract,
  buildValueBets,
} from '../src/marketOdds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

test('normalizePlayerName strips accents, punctuation and case', () => {
  assert.equal(normalizePlayerName('Núñez Jr.'), 'nunez jr');
  assert.equal(normalizePlayerName('  Andrey   Rublev '), 'andrey rublev');
});

test('nameTokenKey is order-invariant (the real ESPN-vs-Kalshi name-order mismatch, 24 sep 2026)', () => {
  // ESPN's athlete.displayName for this player is "Zhou Yi" (surname first,
  // per his own firstName/lastName); Kalshi's yes_sub_title is "Yi Zhou"
  // (Western order). A plain string match, and a last-word-only fallback,
  // both fail on this real pair -- the token-set key is what makes them equal.
  assert.equal(nameTokenKey('Zhou Yi'), nameTokenKey('Yi Zhou'));
  assert.notEqual(normalizePlayerName('Zhou Yi'), normalizePlayerName('Yi Zhou'));
});

test('matchPlayerToMarket: exact match, order-invariant match, and no false positive', () => {
  const markets = loadFixture('kalshi_atpmatch.json');

  const exact = matchPlayerToMarket('Andrey Rublev', markets);
  assert.equal(exact.ticker, 'KXATPMATCH-26SEP25HIJRUB-RUB');

  // the real name-order mismatch: ESPN says "Zhou Yi", Kalshi's yes_sub_title says "Yi Zhou"
  const orderMismatch = matchPlayerToMarket('Zhou Yi', markets);
  assert.ok(orderMismatch, 'expected the order-invariant fallback to find Yi Zhou');
  assert.equal(orderMismatch.ticker, 'KXATPMATCH-26SEP21CERZHO-ZHO');

  const none = matchPlayerToMarket('Nobody Real', markets);
  assert.equal(none, null);

  const empty = matchPlayerToMarket('', markets);
  assert.equal(empty, null);
});

test('quoteFromMarket parses Kalshi\'s string dollar fields into numbers', () => {
  const markets = loadFixture('kalshi_atpmatch.json');
  const hij = markets.find((m) => m.yes_sub_title === 'Rinky Hijikata');
  const quote = quoteFromMarket(hij);
  assert.equal(quote.yesBid, 0.28);
  assert.equal(quote.yesAsk, 0.29);
  assert.equal(quote.noBid, 0.71);
  assert.equal(quote.noAsk, 0.72);
  assert.equal(quote.openInterest, 328.5);
  assert.equal(quoteFromMarket(null), null);
});

test('feePerContract matches Kalshi\'s rate*p*(1-p) model, symmetric around 0.5', () => {
  assert.ok(Math.abs(feePerContract(0.5) - 0.07 * 0.25) < 1e-12);
  assert.ok(Math.abs(feePerContract(0.2) - feePerContract(0.8)) < 1e-12);
  assert.equal(feePerContract(0), 0);
  assert.equal(feePerContract(1), 0);
});

test('kalshiFee ceils to the cent at the ORDER level, not per contract', () => {
  // feePerContract(0.5) = 0.0175; 10 contracts = 0.175 -> ceil to 0.18
  const fee = kalshiFee(0.5, 10);
  assert.equal(fee, 0.18);
  // a single contract's raw fee (0.0175) still ceils up to a full cent —
  // this is the behavior that would overcharge if ceiled PER contract
  // instead of once per order (10 * 0.02 = 0.20, not the 0.18 above)
  const singleFee = kalshiFee(0.5, 1);
  assert.equal(singleFee, 0.02);
});

test('kellyFraction: zero at fair value, positive for a real edge, clamped at zero for a bad bet, scaled by the multiplier', () => {
  // price implies market prob 0.5 (price=0.5 for a $1 binary is a break-even bet at p=0.5)
  assert.ok(Math.abs(kellyFraction(0.5, 0.5, 1) - 0) < 1e-9);
  const full = kellyFraction(0.7, 0.5, 1);
  assert.ok(full > 0);
  const half = kellyFraction(0.7, 0.5, 0.5);
  assert.ok(Math.abs(half - full / 2) < 1e-9);
  // true prob below the price implies a losing bet -> clamp to 0, never short
  assert.equal(kellyFraction(0.3, 0.5, 1), 0);
  assert.equal(kellyFraction(0.5, 0, 1), 0);
  assert.equal(kellyFraction(0.5, 1, 1), 0);
});

test('evaluateContract picks whichever side (YES/NO) has the better fee-adjusted edge', () => {
  const quote = { yesBid: 0.28, yesAsk: 0.29, noBid: 0.71, noAsk: 0.72 };
  // model strongly favors this player (0.7) -> YES should win
  const favored = evaluateContract(0.7, quote, 0.07);
  assert.equal(favored.side, 'YES');
  // model strongly disfavors this player (0.1) -> NO should win
  const disfavored = evaluateContract(0.1, quote, 0.07);
  assert.equal(disfavored.side, 'NO');
});

test('buildValueBets: flags VALUE above the edge threshold, WATCH below, and never exceeds the bankroll caps', () => {
  const rows = [
    { matchId: 'm1', player: 'Big Edge', modelProb: 0.75, quote: { yesBid: 0.5, yesAsk: 0.52, noBid: 0.48, noAsk: 0.5, openInterest: 1000 } },
    { matchId: 'm2', player: 'Small Edge', modelProb: 0.52, quote: { yesBid: 0.5, yesAsk: 0.51, noBid: 0.49, noAsk: 0.5, openInterest: 1000 } },
    { matchId: 'm3', player: 'No Market', modelProb: 0.6, quote: null },
    { matchId: 'm4', player: 'Illiquid', modelProb: 0.9, quote: { yesBid: 0.1, yesAsk: 0.9, noBid: 0.1, noAsk: 0.9, openInterest: 0 } },
  ];
  const results = buildValueBets(rows, {
    edgeThreshold: 0.05,
    bankroll: 1000,
    maxPerPositionPct: 0.02,
    maxTotalExposurePct: 0.05,
    minMarketOpenInterest: 5,
  });

  const byId = Object.fromEntries(results.map((r) => [r.matchId, r]));
  assert.equal(byId.m1.verdict, 'VALUE');
  assert.equal(byId.m2.verdict, 'WATCH');
  assert.equal(byId.m3.verdict, 'NO_MARKET');
  assert.equal(byId.m4.verdict, 'ILLIQUID');

  // position cap: 2% of 1000 = 20
  assert.ok(byId.m1.suggestedStake <= 20.0001);
  // total exposure cap: 5% of 1000 = 50, only one VALUE row here so it just hits the position cap
  const totalStaked = results.reduce((sum, r) => sum + (r.suggestedStake || 0), 0);
  assert.ok(totalStaked <= 50.0001);
});

test('buildValueBets: total exposure cap is enforced across multiple VALUE rows, biggest edge funded first', () => {
  const quote = { yesBid: 0.4, yesAsk: 0.42, noBid: 0.58, noAsk: 0.6, openInterest: 1000 };
  const rows = [
    { matchId: 'a', modelProb: 0.9, quote }, // biggest edge
    { matchId: 'b', modelProb: 0.8, quote },
    { matchId: 'c', modelProb: 0.7, quote },
  ];
  const results = buildValueBets(rows, {
    edgeThreshold: 0.05,
    bankroll: 1000,
    maxPerPositionPct: 0.5, // deliberately loose so the TOTAL cap is what binds
    maxTotalExposurePct: 0.03, // 30 total
  });
  const total = results.reduce((sum, r) => sum + (r.suggestedStake || 0), 0);
  assert.ok(total <= 30.0001);
  const byId = Object.fromEntries(results.map((r) => [r.matchId, r]));
  // the biggest-edge row should be funded first and fully within its own position cap
  assert.ok(byId.a.suggestedStake > 0);
});
