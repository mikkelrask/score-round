import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPair, SignJWT } from 'jose';
import { freshState, validateState, importBouts } from '../data.js';
import { getIdentity } from '../functions/api/_auth.js';
import { onRequest } from '../functions/api/_middleware.js';
import { onRequestGet, onRequestPut } from '../functions/api/state.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_scorecards.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
}
const bout = (id = '81d80f79-f0bd-4323-b05a-1c6cf47a2dd1') => ({
  id, red: { name: 'Pili' }, blue: { name: 'Katie Taylor' }, weightClass: '', roundsTotal: 10,
  roundLen: 120, rounds: Array.from({ length: 10 }, (_, i) => ({ winner: [2, 5].includes(i) ? 'even' : i === 6 ? 'red' : 'blue', kd: { red: 0, blue: 0 }, ded: { red: 0, blue: 0 } })),
  status: 'done', result: { type: 'UD', winner: 'blue', round: null, note: '' },
  date: '2026-09-05T21:10:17.761Z', startedAt: '2026-09-05T21:10:17.763Z', endedAt: '2026-09-08T21:39:45.277Z', draft: null,
});

test('existing exports are lossless, deduplicate by ID, and malformed imports are atomic', () => {
  const originals = [bout(), bout('second'), bout('third'), bout('fourth')];
  const s = importBouts(freshState(), { exportedAt: '2026-10-02', bouts: originals });
  assert.equal(s.added, 4); assert.deepEqual(s.state.history, originals);
  const again = importBouts(s.state, { bouts: originals });
  assert.equal(again.added, 0); assert.equal(again.skipped, 4);
  assert.throws(() => importBouts(s.state, { bouts: [bout('fifth'), { ...bout('bad'), roundsTotal: '10' }] }));
  assert.equal(s.state.history.length, 4);
  assert.equal(importBouts(freshState(), { bout: bout() }).added, 1);
});

test('history retains more than 50 fights; unsafe IDs and duplicate saved IDs are rejected', () => {
  const s = importBouts(freshState(), { bouts: Array.from({ length: 60 }, (_, i) => bout(`b-${i}`)) }).state;
  assert.equal(s.history.length, 60);
  assert.throws(() => importBouts(s, { bouts: [bout('" onclick="bad')] }));
  assert.throws(() => validateState({ ...s, history: [bout(), bout()] }));
});

test('Access verifies signatures, issuer, audience, expiry, and requires a personal identity', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const env = { ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: 'scorecard' };
  async function token(changes = {}, expiration = '1h') {
    return new SignJWT({ type: 'app', sub: 'person-1', email: 'Player@Example.com', ...changes })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer('https://test.cloudflareaccess.com')
      .setAudience('scorecard').setExpirationTime(expiration).sign(privateKey);
  }
  const request = (t) => new Request('https://boxing-round.pages.dev/api/me', { headers: { 'Cf-Access-Jwt-Assertion': t } });
  assert.deepEqual(await getIdentity(request(await token()), env, publicKey), { sub: 'person-1', email: 'player@example.com' });
  await assert.rejects(getIdentity(request(await token()), { ...env, ACCESS_AUD: 'other' }, publicKey));
  await assert.rejects(getIdentity(request(await token()), { ...env, ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com' }, publicKey));
  await assert.rejects(getIdentity(request(await token({}, 946684800)), env, publicKey));
  await assert.rejects(getIdentity(request(await token({ sub: '' })), env, publicKey));
  const other = await generateKeyPair('RS256');
  await assert.rejects(getIdentity(request(await token()), env, other.publicKey));
  await assert.rejects(getIdentity(new Request('https://boxing-round.pages.dev/api/me'), { DEV_USER_EMAIL: 'attacker@example.com' }));
});

async function api(DB, email, method = 'GET', body, extraHeaders = {}, subPath = 'state') {
  const meContext = { request: new Request('http://localhost/api/me'), env: { DB, DEV_USER_EMAIL: email }, data: {}, next() { return Response.json({ user: this.data.user }); } };
  const meResponse = await onRequest(meContext);
  const { user } = await meResponse.json();
  const headers = { 'X-Scorecard-User': user.id, ...(body ? { Origin: 'http://localhost', 'Content-Type': 'application/json' } : {}), ...extraHeaders };
  const context = {
    request: new Request(`http://localhost/api/${subPath}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
    env: { DB, DEV_USER_EMAIL: email }, data: {},
    next() { return method === 'PUT' ? onRequestPut(this) : onRequestGet(this); },
  };
  const result = await onRequest(context);
  return { status: result.status, body: await result.json(), headers: result.headers };
}

test('two accounts scoring the same fight remain isolated; stale writes cannot overwrite cloud data', async () => {
  const DB = database();
  const alice = await api(DB, 'alice@example.com');
  assert.equal(alice.body.revision, 0); assert.equal(alice.headers.get('Cache-Control'), 'no-store');
  const a = importBouts(freshState(), { bouts: [bout()] }).state;
  assert.equal((await api(DB, 'alice@example.com', 'PUT', { revision: 0, state: a })).status, 200);
  assert.equal((await api(DB, 'bob@example.com')).body.state.history.length, 0);
  const b = structuredClone(a); b.history[0].result.note = 'Bob’s own opinion';
  await api(DB, 'bob@example.com', 'PUT', { revision: 0, state: b, user_id: 'alice' });
  assert.equal((await api(DB, 'alice@example.com')).body.state.history[0].result.note, '');
  assert.equal((await api(DB, 'bob@example.com')).body.state.history[0].result.note, 'Bob’s own opinion');
  const stale = await api(DB, 'alice@example.com', 'PUT', { revision: 0, state: freshState() });
  assert.equal(stale.status, 409); assert.deepEqual(stale.body.state, a);
  assert.equal((await api(DB, 'alice@example.com')).body.revision, 1);
  assert.equal((await api(DB, 'new@example.com', 'PUT', { revision: 10, state: a })).status, 409);
  assert.equal((await api(DB, 'new@example.com')).body.revision, 0);
});

test('malformed or cross-origin saves are rejected without changing stored cards', async () => {
  const DB = database();
  assert.equal((await api(DB, 'a@example.com', 'PUT', { revision: 0, state: freshState() }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await api(DB, 'a@example.com', 'PUT', { revision: 0, state: { history: [] } })).status, 400);
  assert.equal((await api(DB, 'a@example.com')).body.revision, 0);
  assert.equal((await api(DB, 'a@example.com', 'PUT', { revision: 0, state: freshState() }, { 'X-Scorecard-User': 'previous-account' })).status, 401);
});
