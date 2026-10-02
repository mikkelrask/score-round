import { sharedFight, cornerOrder } from './fight-night.js';
// A lobby contains setup metadata, never scoring progress or outcomes.
export function buildLobby(rows, userId, now = Date.now()) {
  const groups = new Map();
  for (const { id, email, card } of rows) {
    const started = Date.parse(card?.startedAt);
    if (!sharedFight(card) || card.status !== 'active' || !Number.isFinite(started) || now - started > 86400000 || started > now + 300000) continue;
    // Separate incompatible setups rather than silently placing users in one room.
    let group = [...groups.values()].find(g => cornerOrder(g.reference, card) && g.reference.roundLen === card.roundLen);
    if (!group) {
      const key = `${card.sourceFight.id}:${groups.size}`;
      group = { key, reference: card, people: [] }; groups.set(key, group);
    }
    group.people.push({ name: email.split('@')[0], you: id === userId });
  }
  return [...groups.values()].map(({ reference: card, people }) => ({
    // Key is derived from public fight/settings, independent of personal card IDs.
    fight: { id: card.sourceFight.id, eventId: card.sourceFight.eventId || null, eventTitle: card.sourceFight.eventTitle,
      day: card.sourceFight.day, eventDay: card.sourceFight.day, red: { name: card.red.name, fighterId: card.sourceFight.redFighterId || null },
      blue: { name: card.blue.name, fighterId: card.sourceFight.blueFighterId || null }, weightClass: card.weightClass,
      roundsTotal: card.roundsTotal, roundLen: card.roundLen, cornersConfirmed: card.sourceFight.cornersConfirmed,
      venue: card.venue || '', location: card.location || '' }, people: people.sort((a,b) => a.name.localeCompare(b.name)),
  })).sort((a,b) => b.people.length - a.people.length || a.fight.eventTitle.localeCompare(b.fight.eventTitle));
}
