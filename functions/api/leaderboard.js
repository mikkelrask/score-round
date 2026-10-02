import { json } from './_middleware.js';
import { leaderboard } from './_judging.js';
export async function onRequestGet({ env, data }) { return json(await leaderboard(env, data.user.id)); }
