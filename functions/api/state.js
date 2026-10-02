import { freshState, validateState, MAX_STATE_BYTES } from '../../data.js';
import { roomChanges, notifyRooms } from './_live.js';
import { json } from './_middleware.js';

async function read(env, user) {
  const row = await env.DB.prepare('SELECT revision, state_json FROM scorecard_state WHERE user_id = ?').bind(user.id).first();
  return row ? { revision: row.revision, state: JSON.parse(row.state_json) } : { revision: 0, state: freshState() };
}
export async function onRequestGet({ env, data }) { return json(await read(env, data.user)); }

export async function onRequestPut({ request, env, data, waitUntil }) {
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Missing request body.' }, 400);
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_STATE_BYTES + 1000) { await reader.cancel(); return json({ error: 'History is too large to sync. Export a backup first.' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Invalid save revision.');
    validateState(body.state);
  } catch (error) { return json({ error: error.message || 'Invalid save.' }, 400); }
  const { revision, state } = body;
  const before = env.FIGHT_ROOMS ? (await read(env, data.user)).state : null;
  const result = await env.DB.prepare(`INSERT INTO scorecard_state (user_id, revision, state_json)
    SELECT ?, 1, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM scorecard_state WHERE user_id = ?)
    ON CONFLICT(user_id) DO UPDATE SET revision = scorecard_state.revision + 1, state_json = excluded.state_json,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE scorecard_state.revision = ?`).bind(data.user.id, JSON.stringify(state), revision, data.user.id, revision).run();
  if (result.meta.changes === 0) return json({ error: 'This account was changed on another device.', ...(await read(env, data.user)) }, 409);
  if (env.FIGHT_ROOMS) {
    const notification = notifyRooms(env.FIGHT_ROOMS, roomChanges(before, state));
    if (waitUntil) waitUntil(notification); else await notification;
  }
  return json({ revision: revision + 1 });
}
