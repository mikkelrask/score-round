import { getPortrait } from './_portraits.js';
import { portraitNameKey } from '../../portrait-data.js';
import { json } from './_middleware.js';
export async function onRequestGet({ request, env }) {
  const name = new URL(request.url).searchParams.get('name')?.trim();
  if (!name || name.length > 200 || portraitNameKey(name).length < 2 || /[\u0000-\u001f]/.test(name)) return json({ error: 'Enter a fighter name.' }, 400);
  return json(await getPortrait(env, name));
}
