import { json } from './_middleware.js';
import { personalStats } from '../../personal-stats.js';
export async function onRequestGet({ env, data }) {
  const [own, cached] = await Promise.all([
    env.DB.prepare('SELECT state_json FROM scorecard_state WHERE user_id = ?').bind(data.user.id).first(),
    env.DB.prepare('SELECT id, payload_json FROM official_fight_cache WHERE payload_json IS NOT NULL').all(),
  ]);
  const officials = new Map(cached.results.map(row => [row.id, JSON.parse(row.payload_json)]));
  return json({ ...personalStats(own ? JSON.parse(own.state_json).history : [], officials), updatedAt: new Date().toISOString() });
}
