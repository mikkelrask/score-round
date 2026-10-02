import { normalizeOfficial, eligibleCard, compareCard, buildLeaderboard } from '../../judging.js';
import { reserveRequest, CACHE_ID } from './_schedule.js';

export async function getOfficial(env, id, { now = Math.floor(Date.now() / 1000), fetcher = fetch } = {}) {
  const DB = env.DB;
  await DB.prepare('INSERT OR IGNORE INTO official_fight_cache (id) VALUES (?)').bind(id).run();
  const row = await DB.prepare('SELECT * FROM official_fight_cache WHERE id = ?').bind(id).first();
  if (row.payload_json) {
    const saved = JSON.parse(row.payload_json);
    if (saved.available || row.refresh_after > now) return saved;
  }
  const pending = { available: false, reason: 'Official scores are being checked. Try again shortly.' };
  if (!env.BOXING_RAPIDAPI_KEY) return { available: false, reason: 'The official scores connection is unavailable.' };
  const token = crypto.randomUUID();
  const lease = await DB.prepare('UPDATE official_fight_cache SET lease_until = ?, lease_token = ? WHERE id = ? AND lease_until <= ?').bind(now + 20, token, id, now).run();
  if (!lease.meta.changes) return row.payload_json ? JSON.parse(row.payload_json) : pending;
  let result, ttl = 3600;
  try {
    await DB.prepare('INSERT OR IGNORE INTO fight_schedule_cache (id) VALUES (?)').bind(CACHE_ID).run();
    await reserveRequest(DB, now);
    const response = await fetcher(`https://boxing-data-api.p.rapidapi.com/v2/fights/${encodeURIComponent(id)}`, {
      headers: { 'X-RapidAPI-Key': env.BOXING_RAPIDAPI_KEY, 'X-RapidAPI-Host': 'boxing-data-api.p.rapidapi.com' },
      signal: AbortSignal.timeout(8000), redirect: 'manual',
    });
    const remaining = response.headers.get('x-ratelimit-requests-remaining'), reset = response.headers.get('x-ratelimit-requests-reset');
    if (remaining != null && /^\d+$/.test(remaining) && reset != null && /^\d+$/.test(reset)) await DB.prepare('UPDATE fight_schedule_cache SET requests_remaining = ?, quota_reset_at = ? WHERE id = ?').bind(Number(remaining), now + Number(reset), CACHE_ID).run();
    if (response.status >= 300 && response.status < 400) throw new Error();
    const payload = await response.json();
    if (!response.ok || payload.error?.code) {
      result = { available: false, reason: payload.error?.code === 'DateOutOfRange' ? 'This fight is outside the subscription’s historical range.' : 'Official scores are temporarily unavailable. Try again later.' };
    } else {
      const raw = Array.isArray(payload.data) ? payload.data[0] : payload.data;
      if (raw?.id !== id) throw new Error();
      result = normalizeOfficial(raw);
      if (result.available) ttl = 86400 * 365; // Retain verified totals beyond the free historical window.
    }
  } catch {
    result = { available: false, reason: 'Could not check official scores. Try again later.' }; ttl = 900;
  }
  await DB.prepare('UPDATE official_fight_cache SET payload_json = ?, refresh_after = ?, lease_until = 0, lease_token = NULL WHERE id = ? AND lease_token = ?').bind(JSON.stringify(result), now + ttl, id, token).run();
  return result;
}
export async function compareSavedCard(env, userId, cardId, options) {
  const row = await env.DB.prepare('SELECT state_json FROM scorecard_state WHERE user_id = ?').bind(userId).first();
  const bout = row && JSON.parse(row.state_json).history.find(b => b.id === cardId);
  if (!bout) return { available: false, reason: 'Save this completed scorecard to the cloud first.' };
  if (!eligibleCard(bout)) return compareCard(bout, null);
  return compareCard(bout, await getOfficial(env, bout.sourceFight.id, options));
}
export async function leaderboard(env, userId) {
  const [users, cached] = await Promise.all([
    env.DB.prepare('SELECT users.id, users.email, scorecard_state.state_json FROM users JOIN scorecard_state ON users.id = scorecard_state.user_id').all(),
    env.DB.prepare('SELECT id, payload_json FROM official_fight_cache WHERE payload_json IS NOT NULL').all(),
  ]);
  const officials = new Map(cached.results.map(r => [r.id, JSON.parse(r.payload_json)]));
  const rows = buildLeaderboard(users.results.map(u => ({ id: u.id, name: u.email.split('@')[0], history: JSON.parse(u.state_json).history })), officials);
  // Do not publish account IDs, email addresses, active bouts or private notes.
  return { rows: rows.map(({ id, ...row }) => ({ ...row, you: id === userId })), updatedAt: new Date().toISOString() };
}
