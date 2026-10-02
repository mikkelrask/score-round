import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { normalizeFight, normalizeSchedule, filterSchedule, groupSchedule, scheduleDay } from '../schedule-data.js';
import { getSchedule, CACHE_ID } from '../functions/api/_schedule.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0002_fight_schedule.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
}
const now = Date.parse('2026-10-02T12:00:00Z') / 1000;
const raw = (id = 'one') => ({
  id, date: '2026-10-03T03:00:00', scheduled_rounds: 8,
  fighters: { fighter_1: { full_name: 'Omari Jones', winner: true }, fighter_2: { full_name: 'Alan Sanchez', winner: false } },
  event: { id: 'event-one', title: 'Project Series: Jones vs Sanchez', date: '2026-10-03T00:00:00' },
  division: { name: 'Super Welterweight' }, venue: 'Caribe Royale Orlando', location: 'Orlando',
  results: { outcome: 'KO', round: 4 }, scores: ['secret-judges-score'], status: 'FINISHED', statistics: { knockdowns: 3 },
});
const provider = (data = [raw()], pages = 1, headers = {}) => Response.json({ data, error: {}, pagination: { total_pages: pages } }, {
  headers: { 'x-ratelimit-requests-remaining': '29', 'x-ratelimit-requests-reset': '3600', ...headers },
});

test('schedule normalization never sends results or winner flags; missing values are explicit', () => {
  const fight = normalizeFight(raw());
  assert.equal(fight.roundsTotal, 8); assert.equal(fight.weightClass, 'Super Welterweight');
  assert.equal(fight.cornersConfirmed, false); assert.equal(fight.roundLen, null);
  const encoded = JSON.stringify(fight);
  for (const spoiler of ['winner', 'results', 'scores', 'FINISHED', 'statistics', 'secret-judges-score']) assert.equal(encoded.includes(spoiler), false);
  const incomplete = raw(); delete incomplete.scheduled_rounds; delete incomplete.division;
  assert.equal(normalizeFight(incomplete).roundsTotal, null); assert.equal(normalizeFight(incomplete).weightClass, '');
  assert.equal(normalizeFight({ ...raw(), id: '" onclick="unsafe' }), null);
  assert.equal(normalizeFight({ ...raw(), fighters: {} }), null);
  assert.equal(scheduleDay('2026-02-30T12:00:00'), null);
  assert.equal(normalizeSchedule([raw(), raw(), { id: 'bad' }]).fights.length, 1);
});

test('only explicit corner data establishes red and blue; fighter order does not', () => {
  const r = raw(); r.fighters.fighter_1.corner = 'blue'; r.fighters.fighter_2.corner = 'red';
  const fight = normalizeFight(r);
  assert.equal(fight.red.name, 'Alan Sanchez'); assert.equal(fight.blue.name, 'Omari Jones'); assert.equal(fight.cornersConfirmed, true);
});

test('today/weekend/search use provider calendar dates and group by event', () => {
  const a = normalizeFight(raw());
  const b = normalizeFight({ ...raw('two'), date: '2026-10-04T04:00:00', event: { ...raw().event, date: '2026-10-03T23:00:00' } });
  const c = normalizeFight({ ...raw('next-week'), date: '2026-10-09T03:00:00', event: { id: 'next-event', date: '2026-10-09', title: 'Next card' } });
  const friday = new Date(2026, 9, 2, 12);
  assert.equal(filterSchedule([a, b, c], 'today', '', friday).length, 0);
  assert.equal(filterSchedule([a, b, c], 'weekend', '', friday).length, 2);
  assert.equal(filterSchedule([a, b, c], 'weekend', '', new Date(2026, 9, 4, 12)).length, 2);
  assert.equal(filterSchedule([a, b, c], 'week', 'omari welterweight', friday).length, 3);
  assert.equal(filterSchedule([a, b, c], 'week', 'next card', friday).length, 1);
  assert.equal(groupSchedule([a, b, c]).length, 2);
});

test('all users reuse the same cache; checking again does not spend another provider call', async () => {
  const DB = database(); let calls = 0;
  const env = { DB, BOXING_RAPIDAPI_KEY: 'test-only' };
  const fetcher = async (url, options) => {
    calls++; assert.ok(url.includes('days=7')); assert.ok(url.includes('page_num=1'));
    assert.equal(options.headers['X-RapidAPI-Key'], 'test-only'); return provider();
  };
  const first = await getSchedule(env, { now, fetcher });
  const second = await getSchedule(env, { now: now + 30, fetcher });
  assert.equal(calls, 1); assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second).includes('test-only'), false);
  assert.equal((await DB.prepare('SELECT requests FROM fight_schedule_usage WHERE month = ?').bind('2026-10').first()).requests, 1);
});

test('provider redirects are not followed or forwarded with credentials', async () => {
  const DB = database(); let calls = 0;
  await assert.rejects(getSchedule({ DB, BOXING_RAPIDAPI_KEY: 'test-only' }, {
    now, fetcher: async (_url, options) => {
      calls++; assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: 'https://another-host.example/' } });
    },
  }), /connection is unavailable/);
  assert.equal(calls, 1);
});

test('a database lease prevents simultaneous browsers from multiplying upstream requests', async () => {
  const DB = database(); let finish, started, calls = 0;
  const gate = new Promise((resolve) => { started = resolve; });
  const env = { DB, BOXING_RAPIDAPI_KEY: 'test-only' };
  const fetcher = async () => { calls++; started(); return new Promise((resolve) => { finish = resolve; }); };
  const pending = getSchedule(env, { now, fetcher }); await gate;
  await assert.rejects(getSchedule(env, { now, fetcher }), /being loaded/);
  finish(provider()); await pending; assert.equal(calls, 1);
});

test('provider errors retain stale data and are cached to avoid draining request allowance', async () => {
  const DB = database(); const env = { DB, BOXING_RAPIDAPI_KEY: 'test-only' };
  await getSchedule(env, { now, fetcher: async () => provider() });
  let failures = 0;
  const failing = async () => { failures++; return Response.json({ error: { code: 'DateOutOfRange' }, data: null }, { status: 403 }); };
  const stale = await getSchedule(env, { now: now + 21601, fetcher: failing });
  assert.equal(stale.stale, true); assert.equal(stale.fights.length, 1); assert.match(stale.notice, /subscription/);
  await getSchedule(env, { now: now + 21610, fetcher: failing }); assert.equal(failures, 1);
});

test('pagination is bounded and incomplete coverage is marked, without exposing raw next-page URLs', async () => {
  const DB = database(); let calls = 0;
  const result = await getSchedule({ DB, BOXING_RAPIDAPI_KEY: 'test-only' }, {
    now, fetcher: async () => provider([raw(`page-${++calls}`)], 100),
  });
  assert.equal(calls, 3); assert.equal(result.fights.length, 3); assert.equal(result.partial, true);
});

test('provider quota and monthly request cap stop fetching before additional calls', async () => {
  const DB = database(); const env = { DB, BOXING_RAPIDAPI_KEY: 'test-only' };
  await DB.prepare('INSERT INTO fight_schedule_cache (id, requests_remaining, quota_reset_at) VALUES (?, 0, ?)').bind(CACHE_ID, now + 500).run();
  let calls = 0; const fetcher = async () => { calls++; return provider(); };
  await assert.rejects(getSchedule(env, { now, fetcher }), /allowance/); assert.equal(calls, 0);
  const DB2 = database();
  await DB2.prepare('INSERT INTO fight_schedule_usage (month, requests) VALUES (?, 80)').bind('2026-10').run();
  await assert.rejects(getSchedule({ DB: DB2, BOXING_RAPIDAPI_KEY: 'test-only' }, { now, fetcher }), /allowance/);
  assert.equal(calls, 0);
});
