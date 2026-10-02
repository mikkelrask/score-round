import { json } from './_middleware.js';
import { compareSavedCard } from './_judging.js';
export async function onRequestPost({ request, env, data }) {
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Invalid scorecard reference.' }, 400);
  let body = ''; let bytes = 0; const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 300) { await reader.cancel(); return json({ error: 'Invalid scorecard reference.' }, 400); }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  let id;
  try { id = JSON.parse(body).id; } catch {}
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return json({ error: 'Invalid scorecard reference.' }, 400);
  return json(await compareSavedCard(env, data.user.id, id));
}
