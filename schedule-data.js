const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const number = (value, min, max) => value !== '' && value != null && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : null;

export function scheduleDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

// Explicit allowlist: results, judges' scores, winner flags and fight status never leave the API.
export function normalizeFight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fightId = id(raw.id), day = scheduleDay(raw.date);
  if (!fightId || !day) return null;
  const fighters = raw.fighters || {};
  let first = fighters.fighter_1, second = fighters.fighter_2, cornersConfirmed = false;
  if (fighters.red && fighters.blue) {
    first = fighters.red; second = fighters.blue; cornersConfirmed = true;
  } else if (first?.corner === 'red' && second?.corner === 'blue') cornersConfirmed = true;
  else if (first?.corner === 'blue' && second?.corner === 'red') {
    [first, second] = [second, first]; cornersConfirmed = true;
  }
  const redName = text(first?.full_name || first?.name), blueName = text(second?.full_name || second?.name);
  if (!redName || !blueName) return null;
  return {
    id: fightId, eventId: id(raw.event?.id),
    eventTitle: text(raw.event?.title) || `${redName} vs ${blueName}`,
    eventDay: scheduleDay(raw.event?.date) || day, day,
    red: { name: redName }, blue: { name: blueName },
    weightClass: text(raw.division?.name), roundsTotal: number(raw.scheduled_rounds, 1, 24),
    roundLen: number(raw.round_length_seconds, 30, 600), cornersConfirmed,
    venue: text(raw.venue), location: text(raw.location || raw.event?.location),
  };
}

export function normalizeSchedule(rawFights) {
  const fights = new Map(); let omitted = 0;
  for (const raw of rawFights) {
    const fight = normalizeFight(raw);
    if (fight) fights.set(fight.id, fight); else omitted++;
  }
  return { fights: [...fights.values()].sort((a, b) => a.eventDay.localeCompare(b.eventDay) || a.day.localeCompare(b.day) || a.id.localeCompare(b.id)), omitted };
}

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function filterSchedule(fights, period, query = '', now = new Date()) {
  const today = localDay(now), from = new Date(now);
  // Friday through Sunday, including the Friday preceding the current Saturday/Sunday.
  const day = from.getDay();
  from.setDate(from.getDate() + (day === 0 ? -2 : day === 6 ? -1 : (5 - day + 7) % 7));
  const end = new Date(from); end.setDate(end.getDate() + 3);
  const startDay = localDay(from), endDay = localDay(end);
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 8);
  const weekEndDay = localDay(weekEnd);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return fights.filter((fight) => {
    const date = fight.eventDay;
    const inPeriod = period === 'week' ? date >= today && date < weekEndDay : (period === 'today' ? date === today : date >= startDay && date < endDay);
    const haystack = `${fight.red.name} ${fight.blue.name} ${fight.eventTitle} ${fight.weightClass} ${fight.location}`.toLocaleLowerCase();
    return inPeriod && terms.every((term) => haystack.includes(term));
  });
}

export function groupSchedule(fights) {
  const events = new Map();
  for (const fight of fights) {
    const key = fight.eventId || `${fight.eventTitle}:${fight.eventDay}:${fight.venue}`;
    if (!events.has(key)) events.set(key, { title: fight.eventTitle, day: fight.eventDay, location: fight.location, fights: [] });
    events.get(key).fights.push(fight);
  }
  return [...events.values()];
}
