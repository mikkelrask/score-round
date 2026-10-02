import { getSchedule } from './_schedule.js';
import { json } from './_middleware.js';

export async function onRequestGet({ env }) {
  try { return json(await getSchedule(env)); }
  catch (error) { return json({ error: error.message }, 503); }
}
