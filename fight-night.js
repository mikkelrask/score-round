// Public fight-night projections: committed rounds only, in the viewer's corner order.
import { cardTotals, compareCard, eligibleCard } from './judging.js';
const nameKey = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const sharedFight = bout => bout?.sourceFight?.provider === 'boxing-data';
export function cornerOrder(viewer, other) {
  if (!sharedFight(viewer) || !sharedFight(other) || viewer.sourceFight.id !== other.sourceFight.id || viewer.roundsTotal !== other.roundsTotal) return null;
  const matches = (a, b) => {
    const first = viewer.sourceFight[`${a}FighterId`], second = other.sourceFight[`${b}FighterId`];
    return first && second ? first === second : nameKey(viewer[a].name) === nameKey(other[b].name);
  };
  if (matches('red', 'red') && matches('blue', 'blue') && !matches('red', 'blue')) return ['red', 'blue'];
  if (matches('red', 'blue') && matches('blue', 'red') && !matches('red', 'red')) return ['blue', 'red'];
  return null;
}
export function buildFightNight(viewer, users, userId, requested, official) {
  const throughRound = Math.min(requested, viewer.rounds.length);
  const participants = users.flatMap(user => {
    const matching = user.cards.filter(card => cornerOrder(viewer, card));
    const card = user.id === userId ? matching.find(card => card.id === viewer.id) : matching.sort((a, b) =>
      (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || String(a.endedAt || a.startedAt).localeCompare(String(b.endedAt || b.startedAt)) || a.id.localeCompare(b.id))[0];
    if (!card) return [];
    const [red, blue] = cornerOrder(viewer, card);
    const rounds = card.rounds.slice(0, throughRound).map(round => ({
      winner: round.winner === 'even' ? 'even' : round.winner === red ? 'red' : 'blue',
      kd: { red: round.kd[red], blue: round.kd[blue] }, ded: { red: round.ded[red], blue: round.ded[blue] },
    }));
    const scores = rounds.map(round => ({ winner: round.winner, ...cardTotals({ rounds: [round] }) }));
    return [{ name: user.name, you: user.id === userId, rounds: scores, submitted: scores.length, totals: cardTotals({ rounds }) }];
  }).sort((a, b) => Number(b.you) - Number(a.you) || a.name.localeCompare(b.name));
  const rounds = Array.from({ length: throughRound }, (_, index) => {
    const votes = { red: 0, blue: 0, even: 0 };
    for (const person of participants) if (person.rounds[index]) votes[person.rounds[index].winner]++;
    return { number: index + 1, votes, submitted: Object.values(votes).reduce((a, b) => a + b, 0), split: Object.values(votes).filter(count => count > 0).length > 1 };
  });
  // Official totals may reveal later rounds or the result, so completed full cards only.
  const final = eligibleCard(viewer) && throughRound === viewer.roundsTotal;
  const comparison = final ? compareCard(viewer, official) : null;
  return { throughRound, fighters: { red: viewer.red.name, blue: viewer.blue.name }, participants, rounds,
    official: comparison?.available ? { available: true, scores: comparison.scores, pairing: comparison.pairing } : final ? { available: false, reason: comparison?.reason } : null };
}
