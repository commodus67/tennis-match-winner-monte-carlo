import { Actor, log } from 'apify'; // NOTE: Actor.log does not exist on this SDK build (apify 3.7.2, apify/actor-node:24) — import log separately or every log call throws.

import { fetchRankingsRaw, fetchScoreboardRaw, parseRankings, extractMatches } from './espn.js';
import { projectMatch, setsToWinFor, DEFAULT_ITERATIONS } from './model.js';
import { fetchKalshiMarkets, matchPlayerToMarket, quoteFromMarket, buildValueBets } from './marketOdds.js';

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
  leagues = 'both', // 'atp' | 'wta' | 'both'
  includeMarketComparison = true,
  rankingSensitivity, // undefined -> model.js default (1.0)
  strengthUncertainty, // undefined -> model.js default (0.15)
  unrankedPoints, // undefined -> model.js default (200)
  iterations = DEFAULT_ITERATIONS,
  edgeThreshold = 0.05,
  bankroll = 0,
  maxPerPositionPct = 0.02,
  maxTotalExposurePct = 0.2,
  kellyFractionMultiplier = 0.5,
  minMarketOpenInterest = 5, // most set-winner-style markets sit at 0 OI until the match is underway (verified 24 sep 2026); this floor keeps dead markets out of the edge scan
  maxMatchesPerLeague = 0, // 0 = no cap
  includeQualifying = false, // qualifying rounds rarely have a Kalshi market; excluded by default so runs aren't charged for uncomparable rows
  archiveToNamedDataset = '',
} = input;

const modelOpts = { rankingSensitivity, strengthUncertainty, unrankedPoints, iterations };

const leaguesToRun = leagues === 'both' ? ['atp', 'wta'] : [leagues];
const KALSHI_SERIES = { atp: 'KXATPMATCH', wta: 'KXWTAMATCH' };

const rows = [];
const retrievedAt = new Date().toISOString();

for (const league of leaguesToRun) {
  let rankingsById;
  let matches;
  try {
    const [rankingsRaw, scoreboardRaw] = await Promise.all([fetchRankingsRaw(league), fetchScoreboardRaw(league)]);
    rankingsById = parseRankings(rankingsRaw);
    matches = extractMatches(scoreboardRaw, league, rankingsById, setsToWinFor, { includeQualifying });
  } catch (err) {
    log.error(`ESPN data load failed for ${league}, skipping this league`, { error: err.message });
    continue;
  }

  if (maxMatchesPerLeague > 0) {
    matches = matches.slice(0, maxMatchesPerLeague);
  }
  log.info(`${league.toUpperCase()}: ${matches.length} matches from the scoreboard`);

  let kalshiMarkets = [];
  if (includeMarketComparison) {
    try {
      kalshiMarkets = await fetchKalshiMarkets(KALSHI_SERIES[league]);
      log.info(`${league.toUpperCase()}: ${kalshiMarkets.length} open ${KALSHI_SERIES[league]} markets from Kalshi`);
    } catch (err) {
      log.warning(`Kalshi market load failed for ${league}, continuing with model-only rows`, { error: err.message });
      kalshiMarkets = [];
    }
  }

  for (const match of matches) {
    const pairs = [
      { self: match.playerA, opponent: match.playerB },
      { self: match.playerB, opponent: match.playerA },
    ];

    for (const { self, opponent } of pairs) {
      const projection = projectMatch({
        pointsA: self.points,
        pointsB: opponent.points,
        setsToWin: match.setsToWin,
        setsWonA: self.setsWon,
        setsWonB: opponent.setsWon,
        ...modelOpts,
      });

      let quote = null;
      if (includeMarketComparison && kalshiMarkets.length) {
        const market = matchPlayerToMarket(self.displayName, kalshiMarkets);
        quote = quoteFromMarket(market);
      }

      rows.push({
        league,
        tournamentName: match.tournamentName,
        round: match.round,
        competitionId: match.competitionId,
        matchState: match.state, // 'pre' | 'in' | 'post'
        setsToWin: match.setsToWin,
        player: self.displayName,
        playerId: self.athleteId,
        playerPoints: self.points,
        playerRank: self.rank,
        playerSetsWon: self.setsWon,
        opponent: opponent.displayName,
        opponentId: opponent.athleteId,
        opponentPoints: opponent.points,
        opponentRank: opponent.rank,
        opponentSetsWon: opponent.setsWon,
        winProbability: projection.winProbA,
        preMatchProbability: projection.preMatchProbA,
        impliedSetProbability: projection.pSet,
        method: projection.method, // 'pre-match' | 'live-simulation'
        modelProb: projection.winProbA, // alias kept for buildValueBets' generic `modelProb` field
        quote,
        simulations: iterations,
        retrievedAt,
      });
    }
  }
}

let finalRows = rows;
if (includeMarketComparison) {
  finalRows = buildValueBets(rows, {
    edgeThreshold,
    bankroll,
    maxPerPositionPct,
    maxTotalExposurePct,
    kellyFractionMultiplier,
    minMarketOpenInterest,
  });
}

let namedDataset = null;
if (archiveToNamedDataset) {
  namedDataset = await Actor.openDataset(archiveToNamedDataset);
}

let charged = 0;
for (const row of finalRows) {
  // eslint-disable-next-line no-await-in-loop
  await Actor.charge({ eventName: 'match-projection' });
  charged += 1;
  const output = {
    league: row.league,
    tournamentName: row.tournamentName,
    round: row.round,
    competitionId: row.competitionId,
    matchState: row.matchState,
    setsToWin: row.setsToWin,
    player: row.player,
    playerId: row.playerId,
    playerPoints: row.playerPoints,
    playerRank: row.playerRank,
    playerSetsWon: row.playerSetsWon,
    opponent: row.opponent,
    opponentId: row.opponentId,
    opponentPoints: row.opponentPoints,
    opponentRank: row.opponentRank,
    opponentSetsWon: row.opponentSetsWon,
    winProbability: row.winProbability,
    preMatchProbability: row.preMatchProbability,
    impliedSetProbability: row.impliedSetProbability,
    method: row.method,
    kalshiTicker: row.quote ? row.quote.ticker : null,
    kalshiYesBid: row.quote ? row.quote.yesBid : null,
    kalshiYesAsk: row.quote ? row.quote.yesAsk : null,
    kalshiOpenInterest: row.quote ? row.quote.openInterest : null,
    side: row.side ?? null,
    edge: row.edge ?? null,
    verdict: row.verdict ?? null,
    kellyFraction: row.kellyFraction ?? null,
    suggestedStake: row.suggestedStake ?? null,
    simulations: row.simulations,
    retrievedAt: row.retrievedAt,
  };
  // eslint-disable-next-line no-await-in-loop
  await Actor.pushData(output);
  if (namedDataset) {
    // eslint-disable-next-line no-await-in-loop
    await namedDataset.pushData(output);
  }
}

log.info(`Done: ${charged} rows charged and pushed across ${leaguesToRun.join(', ')}`);

await Actor.exit();
