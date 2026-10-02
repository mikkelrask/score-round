import { getPortraitImage } from '../../api/_portraits.js';
export async function onRequestGet(context) {
  const key = context.params.key;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return new Response(null, { status: 404 });
  // These are shared, publicly licensed fighter photos, like other static assets.
  // Account scores and notes never enter this route or the edge cache.
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL(`/media/portraits/${key}`, context.request.url).href);
  const saved = await cache?.match(cacheKey);
  if (saved) return saved;
  try {
    const response = await getPortraitImage(context.env, key);
    if (response.ok && cache) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch { return new Response(null, { status: 502 }); }
}
