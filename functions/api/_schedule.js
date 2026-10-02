import { normalizeSchedule } from '../../schedule-data.js';

export const CACHE_ID = 'boxing-data:7';
const TTL = 6 * 60 * 60;
const API_HOST = 'boxing-data-api.p.rapidapi.com';
const MAX_PAGES = 3;

class ScheduleError extends Error {
  constructor(message, delay = 900) { super(message); this.delay = delay; }
}

export async function reserveRequest(DB, now, minimumRemaining = 0) {
  const cache = await DB.prepare('SELECT requests_remaining, quota_reset_at FROM fight_schedule_cache WHERE id = ?').bind(CACHE_ID).first();
  if (cache.requests_remaining != null && cache.requests_remaining <= minimumRemaining && cache.quota_reset_at > now) {
    throw new ScheduleError(minimumRemaining ? 'Keeping the remaining API allowance for schedules and official scores.' : 'The schedule request allowance has been used. You can still enter a fight manually.', cache.quota_reset_at - now);
  }
  const month = new Date(now * 1000).toISOString().slice(0, 7);
  const result = await DB.prepare(`INSERT INTO fight_schedule_usage (month, requests) VALUES (?, 1)
    ON CONFLICT(month) DO UPDATE SET requests = requests + 1 WHERE requests < 80`).bind(month).run();
  if (!result.meta.changes) throw new ScheduleError('The schedule request allowance has been used. You can still enter a fight manually.', TTL);
  const reserved = await DB.prepare(`UPDATE fight_schedule_cache SET requests_remaining = CASE
    WHEN quota_reset_at <= ? THEN NULL ELSE MAX(0, requests_remaining - 1) END WHERE id = ? AND (requests_remaining IS NULL OR quota_reset_at <= ? OR requests_remaining > ?)`).bind(now, CACHE_ID, now, minimumRemaining).run();
  if (!reserved.meta.changes) throw new ScheduleError('The API request allowance is reserved or exhausted. Try again after it resets.', TTL);
}

async function fetchPage(env, page, now, fetcher) {
  await reserveRequest(env.DB, now);
  const url = `https://${API_HOST}/v2/fights/schedule?days=7&date_sort=ASC&page_size=100&page_num=${page}`;
  let response;
  try {
    response = await fetcher(url, {
      headers: { 'X-RapidAPI-Key': env.BOXING_RAPIDAPI_KEY, 'X-RapidAPI-Host': API_HOST },
      signal: AbortSignal.timeout(8000), redirect: 'manual',
    });
  } catch (error) {
    console.warn('Boxing schedule request failed:', error.name, String(error.message).replaceAll(env.BOXING_RAPIDAPI_KEY, '[redacted]').slice(0, 160));
    throw new ScheduleError('Could not refresh the fight schedule. Try again later or enter a fight manually.');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ScheduleError('The schedule connection is unavailable. You can still enter a fight manually.');
  }
  const remaining = response.headers.get('x-ratelimit-requests-remaining');
  const reset = response.headers.get('x-ratelimit-requests-reset');
  if (remaining != null && /^\d+$/.test(remaining) && reset != null && /^\d+$/.test(reset)) {
    await env.DB.prepare('UPDATE fight_schedule_cache SET requests_remaining = ?, quota_reset_at = ? WHERE id = ?')
      .bind(Number(remaining), now + Number(reset), CACHE_ID).run();
  }
  if (response.status === 429) throw new ScheduleError('The schedule request allowance has been used. You can still enter a fight manually.', TTL);
  let payload;
  try { payload = await response.json(); }
  catch {
    console.warn('Boxing schedule returned a non-JSON response:', response.status);
    throw new ScheduleError('The schedule provider returned an unreadable response. You can still enter a fight manually.');
  }
  if (!response.ok || payload.error?.code) {
    console.warn('Boxing schedule upstream error:', response.status, /^[A-Za-z0-9_-]{1,64}$/.test(payload.error?.code) ? payload.error.code : 'unspecified');
    const message = payload.error?.code === 'DateOutOfRange'
      ? 'Your schedule subscription does not cover this date range. You can still enter a fight manually.'
      : response.status === 401 || response.status === 403
        ? 'The schedule connection is unavailable. You can still enter a fight manually.'
        : 'Could not refresh the fight schedule. Try again later or enter a fight manually.';
    throw new ScheduleError(message, TTL);
  }
  if (!Array.isArray(payload.data)) throw new ScheduleError('The schedule provider returned an unreadable response. You can still enter a fight manually.');
  return payload;
}

function cachedResult(row, notice) {
  return {
    ...JSON.parse(row.payload_json), fetchedAt: new Date(row.fetched_at * 1000).toISOString(),
    stale: Boolean(notice || row.last_error), notice: notice || row.last_error || null,
  };
}

export async function getSchedule(env, { now = Math.floor(Date.now() / 1000), fetcher = fetch } = {}) {
  const DB = env.DB;
  await DB.prepare('INSERT OR IGNORE INTO fight_schedule_cache (id) VALUES (?)').bind(CACHE_ID).run();
  const cached = await DB.prepare('SELECT * FROM fight_schedule_cache WHERE id = ?').bind(CACHE_ID).first();
  if (cached.refresh_after > now) {
    if (cached.payload_json) return cachedResult(cached);
    throw new ScheduleError(cached.last_error || 'The fight schedule is temporarily unavailable.');
  }
  if (!env.BOXING_RAPIDAPI_KEY) {
    if (cached.payload_json) return cachedResult(cached, 'Showing a saved schedule. The schedule connection is unavailable.');
    throw new ScheduleError('Scheduled fights are not connected yet. Enter the fight details below.');
  }
  const token = crypto.randomUUID();
  const lease = await DB.prepare(`UPDATE fight_schedule_cache SET lease_token = ?, lease_until = ?
    WHERE id = ? AND lease_until <= ? AND refresh_after <= ?`).bind(token, now + 45, CACHE_ID, now, now).run();
  if (!lease.meta.changes) {
    if (cached.payload_json) return cachedResult(cached, 'Showing the saved schedule while it updates.');
    throw new ScheduleError('The fight schedule is being loaded. Try again in a few seconds.');
  }
  try {
    const first = await fetchPage(env, 1, now, fetcher);
    const totalPages = Number(first.pagination?.total_pages) || 1;
    const records = [...first.data];
    let partial = totalPages > MAX_PAGES;
    for (let page = 2; page <= Math.min(totalPages, MAX_PAGES); page++) {
      try { records.push(...(await fetchPage(env, page, now, fetcher)).data); }
      catch { partial = true; break; }
    }
    const normalized = normalizeSchedule(records);
    if (records.length && !normalized.fights.length) throw new ScheduleError('The schedule provider returned incomplete fight details. You can still enter a fight manually.');
    const result = { fights: normalized.fights, days: 7, partial: partial || normalized.omitted > 0 };
    await DB.prepare(`UPDATE fight_schedule_cache SET payload_json = ?, fetched_at = ?, refresh_after = ?,
      lease_token = NULL, lease_until = 0, last_error = NULL WHERE id = ? AND lease_token = ?`)
      .bind(JSON.stringify(result), now, now + TTL, CACHE_ID, token).run();
    return { ...result, fetchedAt: new Date(now * 1000).toISOString(), stale: false, notice: null };
  } catch (error) {
    const message = error instanceof ScheduleError ? error.message : 'The fight schedule is temporarily unavailable. You can still enter a fight manually.';
    await DB.prepare(`UPDATE fight_schedule_cache SET refresh_after = ?, lease_token = NULL, lease_until = 0,
      last_error = ? WHERE id = ? AND lease_token = ?`).bind(now + (error.delay || 900), message, CACHE_ID, token).run();
    if (cached.payload_json) return cachedResult(cached, message);
    throw new ScheduleError(message);
  }
}
