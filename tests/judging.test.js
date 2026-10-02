import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { eligibleCard, normalizeOfficial, compareCard, buildLeaderboard } from '../judging.js';
import { getOfficial, compareSavedCard, leaderboard } from '../functions/api/_judging.js';
import { freshState } from '../data.js';
const raw = (overrides = {}) => ({ id: 'fight', status: 'FINISHED', scheduled_rounds: 10, results: { outcome: 'UD' },
  fighters: { fighter_1: { full_name: 'A Boxer', fighter_id: 'a', winner: true }, fighter_2: { full_name: 'B Boxer', fighter_id: 'b', winner: false } }, scores: ['97-93', '97-93', '97-93'], ...overrides });
const card = (overrides = {}) => ({ id: 'card', status: 'done', red: { name: 'A Boxer' }, blue: { name: 'B Boxer' }, roundsTotal: 10,
  rounds: Array.from({ length: 10 }, (_, i) => ({ winner: i < 7 ? 'red' : 'blue', kd: { red: 0, blue: 0 }, ded: { red: 0, blue: 0 } })),
  sourceFight: { provider: 'boxing-data', id: 'fight' }, result: { type: 'UD' }, endedAt: '2026-10-02T12:00:00Z', ...overrides });
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_scorecards.sql', '0002_fight_schedule.sql', '0003_official_scores.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  return { prepare(sql) { const args = []; const stmt = { bind(...values) { args.push(...values); return stmt; }, async first() { return sqlite.prepare(sql).get(...args) || null; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; } }; return stmt; } };
}
test('official majority pairs reversed source score order and preserves dissenting split cards', () => {
  const reversed = normalizeOfficial(raw({ scores: ['93-97', '93-97', '93-97'] }));
  assert.deepEqual(reversed.scores, [[97, 93], [97, 93], [97, 93]]);
  const split = normalizeOfficial(raw({ results: { outcome: 'SD' }, scores: ['93-97', '94-96', '96-94'] }));
  assert.deepEqual(split.scores, [[97, 93], [96, 94], [94, 96]]);
  assert.equal(normalizeOfficial(raw({ scores: ['93-97', '94-96', '96-94'] })).available, false);
});
test('ambiguous draws, missing scores, unsafe scores, and unfinished fights stay unranked', () => {
  for (const input of [{ scores: null }, { status: 'LIVE' }, { scores: ['999-93'] }, { results: { outcome: 'KO' } }, { results: { outcome: 'Draw' }, scores: ['97-93', '95-95', '93-97'] }]) assert.equal(normalizeOfficial(raw(input)).available, false);
  assert.equal(normalizeOfficial(raw({ results: { outcome: 'Draw' }, scores: ['95-95', '95-95', '95-95'] })).available, true);
});
test('comparison uses both final totals, maps swapped corners, and normalizes fight length', () => {
  const official = normalizeOfficial(raw());
  assert.equal(compareCard(card(), official).agreement, 100);
  const swapped = card({ red: { name: 'B Boxer' }, blue: { name: 'A Boxer' } });
  swapped.rounds = swapped.rounds.map(r => ({ ...r, winner: r.winner === 'red' ? 'blue' : 'red' }));
  assert.equal(compareCard(swapped, official).agreement, 100);
  assert.deepEqual(compareCard(swapped, official).scores[0], { red: 93, blue: 97 });
  const different = card(); different.rounds[9].winner = 'red';
  assert.equal(compareCard(different, official).agreement, 90);
  assert.equal(compareCard(card({ red: { name: 'Someone else' } }), official).available, false);
  assert.equal(compareCard(card({ roundsTotal: 12 }), official).available, false);
});
test('stoppages, active fights, manual and incomplete cards never count', () => {
  for (const bout of [card({ status: 'active' }), card({ sourceFight: null }), card({ rounds: [] }), card({ result: { type: 'KO' } })]) assert.equal(eligibleCard(bout), false);
});
test('leaderboard counts each fight once, uses earliest card, and ties share rank', () => {
  const official = new Map([['fight', normalizeOfficial(raw())]]);
  const duplicate = card({ id: 'later', endedAt: '2026-10-03T12:00:00Z' }); duplicate.rounds[9].winner = 'red';
  const rows = buildLeaderboard([{ id: 'u', name: 'First', history: [duplicate, card()] }, { id: 'v', name: 'Second', history: [card()] }, { id: 'w', name: 'Unranked', history: [] }], official);
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.rank), [1, 1]); assert.equal(rows[0].fights, 1); assert.equal(rows[0].agreement, 100);
});
test('official cache is shared, bounded by schedule quota, and prevents parallel provider calls', async () => {
  const DB = database(); const env = { DB, BOXING_RAPIDAPI_KEY: 'test-key' }; let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(options.redirect, 'manual'); return Response.json({ data: raw(), error: {} }); };
  const first = await getOfficial(env, 'fight', { now: 1000, fetcher });
  const second = await getOfficial(env, 'fight', { now: 1001, fetcher });
  assert.equal(first.available, true); assert.deepEqual(first, second); assert.equal(calls, 1);
  assert.deepEqual(await getOfficial(env, 'fight', { now: 1000 + 86400 * 400, fetcher }), first); assert.equal(calls, 1);
  await DB.prepare('UPDATE fight_schedule_cache SET requests_remaining = 0, quota_reset_at = 99999').run();
  assert.equal((await getOfficial(env, 'other', { now: 1002, fetcher })).available, false); assert.equal(calls, 1);
  await DB.prepare('INSERT INTO official_fight_cache (id, lease_until) VALUES (?, ?)').bind('busy', 9999).run();
  assert.equal((await getOfficial(env, 'busy', { now: 1003, fetcher })).available, false); assert.equal(calls, 1);
});
test('server compares saved owner cards only, and leaderboard exposes no private account data', async () => {
  const DB = database();
  await DB.prepare('INSERT INTO users (id,email,access_sub) VALUES (?,?,?)').bind('u', 'mikkel@example.com', 'sub').run();
  const state = freshState(); state.history = [card()]; state.history[0].result.note = 'Private note';
  await DB.prepare('INSERT INTO scorecard_state (user_id,state_json) VALUES (?,?)').bind('u', JSON.stringify(state)).run();
  const env = { DB, BOXING_RAPIDAPI_KEY: 'test-key' }; let calls = 0;
  const options = { now: 1000, fetcher: async () => { calls++; return Response.json({ data: raw() }); } };
  assert.equal((await compareSavedCard(env, 'other-user', 'card', options)).available, false); assert.equal(calls, 0);
  assert.equal((await compareSavedCard(env, 'u', 'card', options)).agreement, 100);
  const board = await leaderboard(env, 'u'); assert.equal(board.rows[0].you, true);
  const encoded = JSON.stringify(board); for (const secret of ['example.com', 'Private note', 'access_sub', '"id"']) assert.equal(encoded.includes(secret), false);
});
