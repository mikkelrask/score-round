import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync } from '../sync.js';
import { freshState } from '../data.js';

function harness(fetcher, map = new Map()) {
  const states = [], statuses = [];
  const storage = { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, v) };
  const cloud = new CloudSync({ fetcher, storage, onState: (s) => states.push(structuredClone(s)), onStatus: (s) => statuses.push(s) });
  return { cloud, map, states, statuses };
}
const me = (id = 'alice') => Response.json({ user: { id, email: `${id}@example.com` } });
const reply = (state = freshState(), revision = 0) => Response.json({ state, revision });

test('offline edits survive reload and resume against their original cloud revision', async () => {
  let offline = false, remote = freshState(), rev = 0;
  const fetcher = async (path, options) => {
    if (offline) throw new Error('Offline');
    if (path === '/api/me') return me();
    if (options.method !== 'PUT') return reply(remote, rev);
    const body = JSON.parse(options.body);
    assert.equal(body.revision, rev); remote = body.state; rev++; return Response.json({ revision: rev });
  };
  const h = harness(fetcher); await h.cloud.start();
  offline = true;
  const local = freshState(); local.prefs.rounds = 12;
  h.cloud.save(local); clearTimeout(h.cloud.timer); await h.cloud.flush();
  assert.equal(JSON.parse(h.map.get(h.cloud.key())).pending, true);
  offline = false;
  const reloaded = harness(fetcher, h.map); await reloaded.cloud.start();
  assert.equal(remote.prefs.rounds, 12); assert.equal(reloaded.cloud.record.pending, false);
});

test('an edit during an in-flight save stays pending and is sent with the new revision', async () => {
  let finish, requests = 0;
  const h = harness(async (path, options) => {
    if (path === '/api/me') return me();
    if (options.method !== 'PUT') return reply();
    requests++;
    if (requests === 1) return new Promise((resolve) => { finish = resolve; });
    assert.equal(JSON.parse(options.body).revision, 1);
    return Response.json({ revision: 2 });
  });
  await h.cloud.start();
  h.cloud.save(freshState()); clearTimeout(h.cloud.timer);
  const saving = h.cloud.flush();
  const later = freshState(); later.prefs.rounds = 12;
  h.cloud.save(later); clearTimeout(h.cloud.timer);
  finish(Response.json({ revision: 1 })); await saving; clearTimeout(h.cloud.timer);
  assert.equal(h.cloud.record.pending, true);
  await h.cloud.flush(); assert.equal(h.cloud.record.pending, false);
  assert.equal(h.cloud.record.state.prefs.rounds, 12);
});

test('remote conflicts retain device edits until an explicit decision, and save a recovery copy', async () => {
  let put = 0;
  const remote = freshState(); remote.prefs.rounds = 4;
  const h = harness(async (path, options) => {
    if (path === '/api/me') return me();
    if (options.method !== 'PUT') return reply();
    put++; return Response.json({ state: remote, revision: 2 }, { status: 409 });
  });
  await h.cloud.start(); const device = freshState(); device.prefs.rounds = 12;
  h.cloud.save(device); clearTimeout(h.cloud.timer); await h.cloud.flush();
  assert.equal(h.cloud.record.state.prefs.rounds, 12);
  await h.cloud.flush(); assert.equal(put, 1);
  h.cloud.resolve(true);
  assert.equal(h.cloud.record.state.prefs.rounds, 4);
  assert.equal(JSON.parse(h.map.get(`${h.cloud.key()}:conflict-backup`)).prefs.rounds, 12);
});

test('account caches are isolated and no identity is guessed if initial login verification fails', async () => {
  const map = new Map([['boxing-scorecard.v2:alice', JSON.stringify({ revision: 1, pending: true, state: freshState() })]]);
  const h = harness(async (path) => path === '/api/me' ? me('bob') : reply(), map);
  await h.cloud.start(); assert.equal(h.cloud.key(), 'boxing-scorecard.v2:bob');
  assert.equal(h.cloud.record.pending, false);
  const failed = harness(async () => { throw new Error('Offline'); }, map);
  assert.equal(await failed.cloud.start(), false); assert.equal(failed.states.length, 0);
});

test('login expiry retains pending local saves and stops requests until sign-in', async () => {
  let expired = false;
  const h = harness(async (path) => expired ? new Response(null, { status: 401 }) : path === '/api/me' ? me() : reply());
  await h.cloud.start(); expired = true;
  h.cloud.save(freshState()); clearTimeout(h.cloud.timer); await h.cloud.flush();
  assert.equal(h.cloud.authRequired, true); assert.equal(h.cloud.record.pending, true);
});
