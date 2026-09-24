// ESPN data loading for ATP/WTA — kept apart from main.js so parsing can be
// unit-tested against real captured fixtures without a network call.
//
// Endpoints (verified live in-browser, 24 sep 2026 — see [[tennis-actor]]):
//   Rankings:  https://site.api.espn.com/apis/site/v2/sports/tennis/{league}/rankings
//   Scoreboard: https://site.api.espn.com/apis/site/v2/sports/tennis/{league}/scoreboard
// {league} is 'atp' or 'wta'. No API key. Top 150 ranked players are
// returned by the rankings endpoint, updated roughly weekly.
//
// KNOWN GOTCHA (ported from the NBA/NHL Actors, applies here too): ESPN
// returns 403 if you send a custom User-Agent header. Only send `accept`
// and let the runtime's default User-Agent through.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/tennis';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ESPN request failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function fetchRankingsRaw(league) {
  return fetchJson(`${BASE}/${league}/rankings`);
}

async function fetchScoreboardRaw(league) {
  return fetchJson(`${BASE}/${league}/scoreboard`);
}

/**
 * Parse a rankings response into a Map keyed by ESPN athlete id, since the
 * scoreboard's competitor.id is the same athlete id (verified 24 sep 2026:
 * competitor.id "14707" matches the /player/_/id/14707/... link in that
 * same competitor's athlete object) — a far more reliable join key than
 * matching display names between two ESPN endpoints.
 */
function parseRankings(rankingsJson) {
  const byAthleteId = new Map();
  const table = (rankingsJson.rankings && rankingsJson.rankings[0] && rankingsJson.rankings[0].ranks) || [];
  for (const entry of table) {
    if (!entry.athlete || !entry.athlete.id) continue;
    byAthleteId.set(String(entry.athlete.id), {
      athleteId: String(entry.athlete.id),
      displayName: entry.athlete.displayName,
      rank: entry.current,
      points: entry.points,
    });
  }
  return byAthleteId;
}

/** Count of completed sets a competitor has won, from ESPN's per-set linescores. */
function setsWonFromLinescores(linescores) {
  if (!Array.isArray(linescores)) return 0;
  return linescores.filter((ls) => ls.winner === true).length;
}

/**
 * Men's Grand Slams are best-of-5; everything else (ATP tour-level, and
 * every WTA event including the women's Slams) is best-of-3. ESPN's own
 * `format.regulation.periods` field is NOT reliable for this (it reports
 * 5 even for best-of-3 ATP 250 matches — confirmed 24 sep 2026), so the
 * tournament-name lookup in model.js (setsToWinFor) is used instead.
 */

/**
 * True for a doubles draw. Each event carries one grouping per draw
 * (singles, doubles); doubles competitors are teams described by `roster`
 * with no `athlete`, so their displayName is undefined. This Actor is
 * singles-only (rankings and KXATPMATCH/KXWTAMATCH are singles), so those
 * draws are skipped. Checked at both the grouping and competitor level
 * because only the competitor shape is guaranteed.
 */
function isDoublesGrouping(grouping) {
  const g = grouping.grouping || {};
  const label = [g.slug, g.displayName, g.name, grouping.type].filter(Boolean).join(' ');
  return /doubles/i.test(label);
}

function isTeamCompetitor(competitor) {
  return !competitor.athlete && (!!competitor.roster || competitor.type === 'team');
}

/** Singles player name, with ESPN's own "TBD" placeholder as the fallback when no athlete is known yet. */
function competitorName(competitor) {
  const name = competitor.athlete && competitor.athlete.displayName;
  return typeof name === 'string' && name.trim() ? name : 'TBD';
}

/**
 * Flatten a scoreboard response into one row per singles match, joined
 * against the rankings map for each competitor's points. Matches with only
 * one or with more than two competitors (data anomalies, or a doubles pair
 * ESPN represents unusually) are skipped rather than guessed at.
 *
 * @param {object} scoreboardJson - raw ESPN scoreboard response
 * @param {'atp'|'wta'} league
 * @param {Map} rankingsById - from parseRankings()
 * @param {function} setsToWinFor - (league, tournamentName) => 2 | 3, injected from model.js to avoid a circular require
 * @param {object} [opts]
 * @param {boolean} [opts.includeQualifying=false] - qualifying-round matches rarely have a Kalshi
 *   KXATPMATCH/KXWTAMATCH market (those track main-draw matchups) and are excluded by default so
 *   a run isn't charged for rows that can never carry a market comparison.
 */
function extractMatches(scoreboardJson, league, rankingsById, setsToWinFor, opts = {}) {
  const { includeQualifying = false } = opts;
  const matches = [];
  const events = scoreboardJson.events || [];
  for (const event of events) {
    const tournamentName = event.name;
    for (const grouping of event.groupings || []) {
      if (isDoublesGrouping(grouping)) continue;
      for (const competition of grouping.competitions || []) {
        const roundName = (competition.round && competition.round.displayName) || '';
        if (!includeQualifying && /qualifying/i.test(roundName)) continue;
        const competitors = competition.competitors || [];
        if (competitors.length !== 2) continue;
        if (competitors.some(isTeamCompetitor)) continue;
        // ESPN's homeAway ordering isn't meaningful for tennis; use `order` when present, else array order.
        const sorted = [...competitors].sort((a, b) => (a.order || 0) - (b.order || 0));
        const [c1, c2] = sorted;
        const rank1 = rankingsById.get(String(c1.id));
        const rank2 = rankingsById.get(String(c2.id));
        matches.push({
          league,
          tournamentName,
          round: roundName || null,
          competitionId: competition.id,
          state: (competition.status && competition.status.type && competition.status.type.state) || 'unknown', // 'pre' | 'in' | 'post'
          completed: !!(competition.status && competition.status.type && competition.status.type.completed),
          startDate: competition.startDate || competition.date || null,
          setsToWin: setsToWinFor(league, tournamentName),
          playerA: {
            athleteId: String(c1.id),
            displayName: competitorName(c1),
            points: rank1 ? rank1.points : null,
            rank: rank1 ? rank1.rank : null,
            setsWon: setsWonFromLinescores(c1.linescores),
            winner: !!c1.winner,
          },
          playerB: {
            athleteId: String(c2.id),
            displayName: competitorName(c2),
            points: rank2 ? rank2.points : null,
            rank: rank2 ? rank2.rank : null,
            setsWon: setsWonFromLinescores(c2.linescores),
            winner: !!c2.winner,
          },
        });
      }
    }
  }
  return matches;
}

export {
  fetchRankingsRaw,
  fetchScoreboardRaw,
  parseRankings,
  extractMatches,
  setsWonFromLinescores,
};
