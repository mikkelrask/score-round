import { json } from './_middleware.js';
export function onRequestGet({ data }) { return json({ user: data.user }); }
