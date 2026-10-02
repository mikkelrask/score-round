export const MAX_STATE_BYTES = 1_500_000;
export const freshState = () => ({ version: 1, active: null, history: [], prefs: { rounds: 10, roundLen: 180 } });

const fail = (message) => { throw new Error(message); };
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const text = (x, max) => typeof x === 'string' && x.length <= max;
const date = (x) => text(x, 40) && Number.isFinite(Date.parse(x));
const validRound = (r, draft = false) => object(r) &&
  (['red', 'blue', 'even'].includes(r.winner) || (draft && r.winner === '')) &&
  ['kd', 'ded'].every((k) => object(r[k]) && ['red', 'blue'].every((s) => integer(r[k][s], 0, 100)));

export function validateBout(b, status = 'done') {
  if (!object(b) || !text(b.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(b.id) ||
      !['red', 'blue'].every((s) => object(b[s]) && text(b[s].name, 200) && b[s].name.trim()) ||
      !text(b.weightClass, 200) || !integer(b.roundsTotal, 1, 24) || !integer(b.roundLen, 30, 600) ||
      !Array.isArray(b.rounds) || b.rounds.length > b.roundsTotal || !b.rounds.every((r) => validRound(r)) ||
      b.status !== status || !date(b.date) || !date(b.startedAt) ||
      (b.endedAt != null && !date(b.endedAt)) ||
      (b.draft != null && !validRound(b.draft, true)) ||
      (b.editingIdx != null && !integer(b.editingIdx, 0, b.rounds.length - 1))) {
    fail('Invalid scorecard. Check the JSON export format.');
  }
  if (b.sourceFight != null && (!object(b.sourceFight) || b.sourceFight.provider !== 'boxing-data' ||
      !text(b.sourceFight.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(b.sourceFight.id) ||
      (b.sourceFight.eventId != null && (!text(b.sourceFight.eventId, 100) || !/^[a-zA-Z0-9_-]+$/.test(b.sourceFight.eventId))) ||
      !text(b.sourceFight.eventTitle, 200) || !/^\d{4}-\d{2}-\d{2}$/.test(b.sourceFight.day) ||
      typeof b.sourceFight.cornersConfirmed !== 'boolean')) fail('Invalid scheduled fight reference.');
  if ((b.venue != null && !text(b.venue, 200)) || (b.location != null && !text(b.location, 200))) fail('Invalid fight location.');
  if (status === 'done' && (!object(b.result) || !date(b.endedAt))) fail('Completed scorecard is missing its result or end date.');
  if (b.result != null && (!object(b.result) ||
      !['UD', 'MD', 'SD', 'Draw', 'KO', 'TKO', 'RTD', 'DQ', 'NC'].includes(b.result.type) ||
      ![null, 'red', 'blue'].includes(b.result.winner) ||
      (b.result.round != null && !integer(b.result.round, 1, b.roundsTotal)) || !text(b.result.note, 10000))) {
    fail('Invalid fight result.');
  }
  return b;
}

export function validateState(s) {
  if (!object(s) || s.version !== 1 || !Array.isArray(s.history) || !object(s.prefs) ||
      !integer(s.prefs.rounds, 1, 24) || !integer(s.prefs.roundLen, 30, 600)) fail('Invalid saved state.');
  s.history.forEach((b) => validateBout(b));
  if (s.active != null) validateBout(s.active, 'active');
  const ids = s.history.map((b) => b.id);
  if (s.active) ids.push(s.active.id);
  if (new Set(ids).size !== ids.length) fail('Duplicate scorecard IDs in saved state.');
  if (new TextEncoder().encode(JSON.stringify(s)).length > MAX_STATE_BYTES) fail('History is too large to sync. Export a backup before removing any cards.');
  return s;
}

export function importBouts(state, payload) {
  const bouts = Array.isArray(payload?.bouts) ? payload.bouts : payload?.bout ? [payload.bout] : null;
  if (!bouts) fail('Choose a scorecard history or single-bout JSON export.');
  bouts.forEach((b) => validateBout(b));
  const next = structuredClone(state);
  const ids = new Set([...next.history.map((b) => b.id), ...(next.active ? [next.active.id] : [])]);
  let added = 0;
  for (const b of bouts) {
    if (ids.has(b.id)) continue;
    next.history.push(structuredClone(b));
    ids.add(b.id);
    added++;
  }
  if (payload.active != null) {
    validateBout(payload.active, 'active');
    if (!next.history.some((b) => b.id === payload.active.id)) {
      if (next.active && next.active.id !== payload.active.id) fail('Finish or discard your current fight before importing another fight in progress.');
      if (!next.active) next.active = structuredClone(payload.active);
    }
  }
  next.history.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  validateState(next);
  return { state: next, added, skipped: bouts.length - added };
}
