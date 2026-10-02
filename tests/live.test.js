import test from 'node:test';
import assert from 'node:assert/strict';
import { roomChanges, notifyRooms } from '../functions/api/_live.js';
import { onRequestGet } from '../functions/api/live.js';
import { FightLive } from '../live-client.js';
const card = { id: 'own', sourceFight: { provider: 'boxing-data', id: 'fight' }, rounds: [{ winner: 'red' }], red: { name: 'Red' }, blue: { name: 'Blue' }, status: 'active', roundsTotal: 12 };
const state = c => ({ active: c, history: [] });
test('notifications cover committed edits, joins and deletions but exclude drafts and notes', () => {
  assert.deepEqual(roomChanges(state(card), state({ ...card, draft: { winner: 'blue' }, note: 'private' })), []);
  assert.deepEqual(roomChanges(state(card), state({ ...card, rounds: [{ winner: 'blue' }] })), ['fight']);
  assert.deepEqual(roomChanges(state(card), state(null)), ['fight']);
  assert.deepEqual(roomChanges(state(null), state(card)), ['fight']);
  assert.deepEqual(roomChanges(state(card), { active: null, history: [card] }), []);
});
test('failed notification cannot fail a saved card or prevent other rooms being notified', async () => {
  const sent = [];
  await notifyRooms({ idFromName: id => id, get: id => ({ changed: async () => { sent.push(id); if (id === 'bad') throw Error('offline'); } }) }, ['bad', 'good']);
  assert.deepEqual(sent, ['bad', 'good']);
});
test('socket subscriptions use owned saved scheduled cards and never a supplied room ID', async () => {
  let room;
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ state_json: JSON.stringify(state(card)) }) }) }) }, FIGHT_ROOMS: { idFromName: id => id, get: id => { room = id; return { fetch: async () => new Response('connected') }; } } };
  const request = id => new Request(`https://app.test/api/live?card=${id}&room=someone-else`, { headers: { Upgrade: 'websocket' } });
  const data = { user: { id: 'owner' } };
  assert.equal((await onRequestGet({ request: request('other'), env, data })).status, 403);
  assert.equal(room, undefined);
  assert.equal((await onRequestGet({ request: request('own'), env, data })).status, 200);
  assert.equal(room, 'fight');
  card.rounds = [];
  assert.equal((await onRequestGet({ request: request('own'), env, data })).status, 403);
  card.rounds = [{ winner: 'red' }];
});
test('client recovers on open, ignores score payloads, and cancels an old room cleanly', () => {
  const sockets = [];
  class Socket { constructor(url) { this.url = String(url); sockets.push(this); } close() { this.onclose?.(); } }
  let changes = 0;
  const live = new FightLive({ Socket, base: 'https://app.test', onChange: () => changes++ });
  live.watch('owner', 'card');
  assert.match(sockets[0].url, /^wss:\/\/app.test\/api\/live\?user=owner&card=card$/);
  sockets[0].onopen();
  assert.equal(changes, 1); assert.equal(live.connected, true);
  sockets[0].onmessage({ data: '{"rounds":["private"]}' });
  assert.equal(changes, 1);
  live.watch(null, null);
  assert.equal(live.connected, false); assert.equal(live.key, '');
  sockets[0].onmessage({ data: 'changed' });
  assert.equal(changes, 1);
});

test('socket account guard requires matching Access identity and a same-origin handshake', async () => {
  const { onRequest } = await import('../functions/api/_middleware.js');
  const env = { DEV_USER_EMAIL:'owner@example.com', DB:{prepare:()=>({bind:()=>({run:async()=>({}),first:async()=>({id:'owner',email:'owner@example.com'})})})} };
  const attempt = (user, origin, extra={}) => onRequest({request:new Request(`http://localhost/api/live?user=${user}`,{headers:{Origin:origin,Upgrade:'websocket',...extra}}),env,data:{},next:async()=>new Response('ok')});
  assert.equal((await attempt('owner','https://evil.test')).status,403);
  assert.equal((await attempt('other','http://localhost')).status,401);
  assert.equal((await attempt('owner','http://localhost')).status,200);
  // A matching user query on a preview URL cannot substitute for an Access JWT.
  const preview = await onRequest({request:new Request('https://preview.pages.dev/api/live?user=owner',{headers:{Origin:'https://preview.pages.dev',Upgrade:'websocket'}}),env,data:{},next:async()=>new Response('ok')});
  assert.equal(preview.status,401);
});
