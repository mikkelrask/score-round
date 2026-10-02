import { json } from './_middleware.js';
import { buildLobby } from '../../lobby.js';
export async function onRequestGet({ env, data }) {
  const rows = await env.DB.prepare(`SELECT users.id, users.email, json_extract(scorecard_state.state_json, '$.active') AS card
    FROM users JOIN scorecard_state ON users.id = scorecard_state.user_id
    WHERE json_extract(scorecard_state.state_json, '$.active.status') = 'active'`).all();
  return json({ rooms: buildLobby(rows.results.map(row => ({ ...row, card: JSON.parse(row.card) })), data.user.id), updatedAt: new Date().toISOString() });
}
