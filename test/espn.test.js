import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRankings, extractMatches, setsWonFromLinescores } from '../src/espn.js';
import { setsToWinFor } from '../src/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

test('parseRankings indexes by athlete id and carries points/rank through', () => {
  const rankings = loadFixture('atp_rankings.json');
  const byId = parseRankings(rankings);
  assert.equal(byId.size, 10);
  const sinner = byId.get('3623');
  assert.equal(sinner.displayName, 'Jannik Sinner');
  assert.equal(sinner.points, 11500);
  assert.equal(sinner.rank, 1);
  assert.equal(byId.has('does-not-exist'), false);
});

test('setsWonFromLinescores counts only sets with winner:true, and is null-safe', () => {
  assert.equal(setsWonFromLinescores([{ value: 6, winner: true }, { value: 0 }]), 1);
  assert.equal(setsWonFromLinescores([{ value: 4, winner: false }, { value: 0 }]), 0);
  assert.equal(setsWonFromLinescores(undefined), 0);
  assert.equal(setsWonFromLinescores(null), 0);
  assert.equal(setsWonFromLinescores([]), 0);
});

test('extractMatches: real live match (24 sep 2026, Cerundolo vs Zhou Yi) carries the right set score and ranking points', () => {
  const scoreboard = loadFixture('atp_scoreboard.json');
  const rankings = parseRankings(loadFixture('atp_rankings.json'));
  const matches = extractMatches(scoreboard, 'atp', rankings, setsToWinFor);
  assert.equal(matches.length, 2);

  const live = matches.find((m) => m.tournamentName === 'Chengdu Open');
  assert.ok(live);
  assert.equal(live.state, 'in');
  assert.equal(live.completed, false);
  assert.equal(live.setsToWin, 2); // not a men's Slam

  // Cerundolo (order 1) has won set 1 (6-4); Zhou Yi (order 2) has not.
  const cerundolo = [live.playerA, live.playerB].find((p) => p.displayName === 'Juan Manuel Cerundolo');
  const zhou = [live.playerA, live.playerB].find((p) => p.displayName === 'Zhou Yi');
  assert.ok(cerundolo && zhou);
  assert.equal(cerundolo.setsWon, 1);
  assert.equal(zhou.setsWon, 0);
  // Cerundolo isn't in the trimmed rankings fixture -> points null, not a crash or a guess
  assert.equal(cerundolo.points, null);
});

test('extractMatches: real pre-match (Rublev vs Hijikata) has 0-0 sets and both players\' ranking points joined correctly', () => {
  const scoreboard = loadFixture('atp_scoreboard.json');
  const rankings = parseRankings(loadFixture('atp_rankings.json'));
  const matches = extractMatches(scoreboard, 'atp', rankings, setsToWinFor);

  const pre = matches.find((m) => m.tournamentName === 'AITO Hangzhou Open');
  assert.ok(pre);
  assert.equal(pre.state, 'pre');

  const rublev = [pre.playerA, pre.playerB].find((p) => p.displayName === 'Andrey Rublev');
  const hijikata = [pre.playerA, pre.playerB].find((p) => p.displayName === 'Rinky Hijikata');
  assert.equal(rublev.points, 1930);
  assert.equal(hijikata.points, 700);
  assert.equal(rublev.setsWon, 0);
  assert.equal(hijikata.setsWon, 0);
});

test('extractMatches excludes qualifying rounds by default, includes them when asked', () => {
  const scoreboard = {
    events: [
      {
        name: 'Some Open',
        groupings: [
          {
            competitions: [
              {
                id: 'q1',
                round: { displayName: 'Qualifying 1st Round' },
                status: { type: { state: 'pre' } },
                competitors: [
                  { id: 'a', order: 1, athlete: { displayName: 'Player A' } },
                  { id: 'b', order: 2, athlete: { displayName: 'Player B' } },
                ],
              },
              {
                id: 'r1',
                round: { displayName: 'Round 1' },
                status: { type: { state: 'pre' } },
                competitors: [
                  { id: 'c', order: 1, athlete: { displayName: 'Player C' } },
                  { id: 'd', order: 2, athlete: { displayName: 'Player D' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const byDefault = extractMatches(scoreboard, 'atp', new Map(), setsToWinFor);
  assert.equal(byDefault.length, 1);
  assert.equal(byDefault[0].competitionId, 'r1');

  const withQualifying = extractMatches(scoreboard, 'atp', new Map(), setsToWinFor, { includeQualifying: true });
  assert.equal(withQualifying.length, 2);
});

test('extractMatches skips competitions that do not have exactly two competitors', () => {
  const scoreboard = {
    events: [
      {
        name: 'Weird Event',
        groupings: [{ competitions: [{ id: '1', competitors: [{ id: 'a', athlete: { displayName: 'Solo Player' } }] }] }],
      },
    ],
  };
  const matches = extractMatches(scoreboard, 'atp', new Map(), setsToWinFor);
  assert.equal(matches.length, 0);
});
