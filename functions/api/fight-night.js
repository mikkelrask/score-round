import { json } from './_middleware.js';
import { sharedFight, buildFightNight } from '../../fight-night.js';
export async function onRequestGet({ request, env, data }) {
  const params = new URL(request.url).searchParams;
  const id = params.get('card'), round = params.get('round');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '') || !/^(?:[1-9]|1\d|2[0-4])$/.test(round || '')) return json({ error: 'Choose a saved card and round.' }, 400);
  const own = await env.DB.prepare('SELECT state_json FROM scorecard_state WHERE user_id = ?').bind(data.user.id).first();
  const state = own && JSON.parse(own.state_json);
  const viewer = state && [state.active, ...state.history].find(card => card?.id === id);
  if (!viewer) return json({ error: 'Save this scorecard to the cloud before revealing scores.' }, 404);
  if (!sharedFight(viewer)) return json({ error: 'Select a scheduled fight to compare with friends.' }, 400);
  if (viewer.rounds.length < Number(round)) return json({ error: 'Save your own round before revealing the room.' }, 403);
  // Only this fight's cards are selected. Full state, notes, drafts and IDs never leave the server.
  const rows = await env.DB.prepare(`WITH cards AS (
    SELECT user_id, json_extract(state_json, '$.active') AS card FROM scorecard_state
    UNION ALL SELECT s.user_id, h.value AS card FROM scorecard_state s, json_each(s.state_json, '$.history') h
  ) SELECT users.id, users.email, cards.card FROM cards JOIN users ON users.id = cards.user_id
    WHERE json_extract(cards.card, '$.sourceFight.provider') = 'boxing-data'
      AND json_extract(cards.card, '$.sourceFight.id') = ?`).bind(viewer.sourceFight.id).all();
  const users = new Map();
  for (const row of rows.results) {
    if (!users.has(row.id)) users.set(row.id, { id: row.id, name: row.email.split('@')[0], cards: [] });
    users.get(row.id).cards.push(JSON.parse(row.card));
  }
  // The owner read defines the reveal gate even if another device writes during this request.
  users.set(data.user.id, { id: data.user.id, name: data.user.email.split('@')[0], cards: [viewer] });
  const cached = viewer.status === 'done' && Number(round) === viewer.roundsTotal ?
    await env.DB.prepare('SELECT payload_json FROM official_fight_cache WHERE id = ?').bind(viewer.sourceFight.id).first() : null;
  return json({ ...buildFightNight(viewer, [...users.values()], data.user.id, Number(round), cached?.payload_json ? JSON.parse(cached.payload_json) : null), updatedAt: new Date().toISOString() });
}
