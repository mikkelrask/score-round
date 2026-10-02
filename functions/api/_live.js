// Compare public committed data only; draft edits do not broadcast notifications.
export function roomChanges(before, after) {
  const rooms = state => {
    const result = new Map();
    for (const card of [state?.active, ...(state?.history || [])]) {
      if (card?.sourceFight?.provider !== 'boxing-data') continue;
      const id = card.sourceFight.id;
      if (!result.has(id)) result.set(id, []);
      result.get(id).push({ id: card.id, red: card.red, blue: card.blue, rounds: card.rounds, status: card.status, roundsTotal: card.roundsTotal, sourceFight: card.sourceFight });
    }
    return new Map([...result].map(([id, cards]) => [id, JSON.stringify(cards.sort((a,b) => a.id.localeCompare(b.id)))]));
  };
  const old = rooms(before), next = rooms(after);
  return [...new Set([...old.keys(), ...next.keys()])].filter(id => old.get(id) !== next.get(id));
}
export async function notifyRooms(namespace, ids) {
  await Promise.allSettled(ids.map(id => namespace.get(namespace.idFromName(id)).changed()));
}
