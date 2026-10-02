import { json } from './_middleware.js';
import { sharedFight } from '../../fight-night.js';
export async function onRequestGet({ request, env, data }) {
  if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required.' }, 426);
  if (!env.FIGHT_ROOMS) return json({ error: 'Live updates unavailable.' }, 503);
  const id = new URL(request.url).searchParams.get('card');
  const row = await env.DB.prepare('SELECT state_json FROM scorecard_state WHERE user_id = ?').bind(data.user.id).first();
  const state = row && JSON.parse(row.state_json);
  const card = state && [state.active, ...state.history].find(card => card?.id === id);
  if (!sharedFight(card) || !card.rounds.length) return json({ error: 'Save a scheduled round before joining.' }, 403);
  return env.FIGHT_ROOMS.get(env.FIGHT_ROOMS.idFromName(card.sourceFight.id)).fetch(request);
}
