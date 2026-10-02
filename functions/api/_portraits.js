import { portraitNameKey, matchBoxer, commonsPortrait, safeImageUrl } from '../../portrait-data.js';
const UA = 'BoxingRound/1.0 (https://github.com/mikkelrask/score-round)';
export async function portraitKey(name) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(portraitNameKey(name)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function wiki(host, params, fetcher) {
  const response = await fetcher(`https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000), redirect: 'manual',
  });
  if (!response.ok || response.headers.get('content-length') > 1500000) throw new Error('Photo lookup unavailable');
  const payload = await response.json();
  if (payload.error) throw new Error('Photo lookup unavailable');
  return payload;
}
function publicPortrait(key, value) {
  if (!value?.available) return { available: false };
  return { ...value, imageUrl: `/media/portraits/${key}` };
}
export async function getPortrait(env, name, { now = Math.floor(Date.now() / 1000), fetcher = fetch } = {}) {
  const key = await portraitKey(name), DB = env.DB;
  await DB.prepare('INSERT OR IGNORE INTO fighter_portraits (id, name) VALUES (?, ?)').bind(key, name).run();
  const row = await DB.prepare('SELECT * FROM fighter_portraits WHERE id = ?').bind(key).first();
  if (row.refresh_after > now && row.payload_json) return publicPortrait(key, JSON.parse(row.payload_json));
  const token = crypto.randomUUID();
  const lease = await DB.prepare('UPDATE fighter_portraits SET lease_token = ?, lease_until = ? WHERE id = ? AND lease_until <= ? AND refresh_after <= ?').bind(token, now + 30, key, now, now).run();
  if (!lease.meta.changes) return row.payload_json ? publicPortrait(key, JSON.parse(row.payload_json)) : { available: false, retry: true };
  let result = { available: false }, ttl = 86400 * 7;
  try {
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    const allowance = await DB.prepare('INSERT INTO portrait_lookup_usage (day,requests) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1 WHERE requests<40').bind(day).run();
    if (!allowance.meta.changes) throw new Error('Daily photo lookup allowance reached');
    const search = await wiki('www.wikidata.org', { action: 'wbsearchentities', search: name, language: 'en', limit: '5' }, fetcher);
    const ids = (search.search || []).map(result => result.id).filter(id => /^Q\d+$/.test(id)).slice(0, 5);
    if (ids.length) {
      const data = await wiki('www.wikidata.org', { action: 'wbgetentities', ids: ids.join('|'), props: 'claims|labels|aliases', languages: 'en' }, fetcher);
      const match = matchBoxer(name, data.entities);
      if (match) {
        const files = await wiki('commons.wikimedia.org', { action: 'query', titles: `File:${match.file}`, prop: 'imageinfo',
          iiprop: 'url|mime|extmetadata', iiurlwidth: '360', iiextmetadatafilter: 'Artist|Attribution|Credit|ObjectName|LicenseShortName|LicenseUrl' }, fetcher);
        const page = Object.values(files.query?.pages || {}).find(page => page.imagerepository === 'local');
        result = commonsPortrait(page?.imageinfo?.[0], match.file, match.id) || result;
        if (result.available) ttl = 86400 * 30;
      }
    }
  } catch { result = row.payload_json ? JSON.parse(row.payload_json) : result; ttl = 3600; }
  await DB.prepare('UPDATE fighter_portraits SET payload_json = ?, refresh_after = ?, lease_until = 0, lease_token = NULL WHERE id = ? AND lease_token = ?')
    .bind(JSON.stringify(result), now + ttl, key, token).run();
  return publicPortrait(key, result);
}
export async function getPortraitImage(env, key, { fetcher = fetch } = {}) {
  const row = await env.DB.prepare('SELECT payload_json FROM fighter_portraits WHERE id = ?').bind(key).first();
  const photo = row?.payload_json && JSON.parse(row.payload_json);
  let url = photo?.available && safeImageUrl(photo.imageUrl);
  if (!url) return new Response(null, { status: 404 });
  let response;
  for (let redirects = 0; redirects <= 2; redirects++) {
    response = await fetcher(url, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('Location');
    if (!location) return new Response(null, { status: 502 });
    url = safeImageUrl(new URL(location, url).href);
    if (!url) return new Response(null, { status: 502 });
  }
  const mime = response.headers.get('Content-Type')?.split(';')[0];
  if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(mime) || Number(response.headers.get('Content-Length')) > 1500000 || !response.body) return new Response(null, { status: 502 });
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > 1500000) { await reader.cancel(); return new Response(null, { status: 502 }); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}
