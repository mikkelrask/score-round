import { getIdentity } from './_auth.js';

export const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export async function onRequest(context) {
  const { request, env, data } = context;
  let identity;
  try { identity = await getIdentity(request, env); }
  catch { return json({ error: 'Sign in to continue.' }, 401); }
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (request.headers.get('Origin') !== new URL(request.url).origin ||
        request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
      return json({ error: 'Invalid request origin or content type.' }, 403);
    }
  }
  if (!env.DB) return json({ error: 'Cloud storage is not configured.' }, 503);
  try {
    await env.DB.prepare('INSERT INTO users (id, email, access_sub) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET access_sub = excluded.access_sub')
      .bind(crypto.randomUUID(), identity.email, identity.sub).run();
    data.user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ? AND access_sub = ?')
      .bind(identity.email, identity.sub).first();
    if (!data.user) return json({ error: 'Unable to identify account.' }, 401);
    const url = new URL(request.url);
    const socket = url.pathname === '/api/live';
    if (socket && request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid socket origin.' }, 403);
    // Browsers cannot set custom headers on WebSocket handshakes. This is an
    // account-switch guard, not a credential; Access still verifies the JWT.
    const account = socket ? url.searchParams.get('user') : request.headers.get('X-Scorecard-User');
    if (url.pathname !== '/api/me' && account !== data.user.id) {
      return json({ error: 'Your signed-in account changed. Reload to open that account.' }, 401);
    }
    const response = await context.next();
    if (response.status === 101) return response;
    const result = new Response(response.body, response);
    result.headers.set('Cache-Control', 'no-store');
    return result;
  } catch (error) {
    console.error('Scorecard API failed', error.message);
    return json({ error: 'Cloud save is unavailable. Your changes remain on this device.' }, 503);
  }
}
