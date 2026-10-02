// Agreement with final official totals, not a measure of judging correctness.
const decisions = new Set(['UD', 'MD', 'SD', 'Draw']);
const nameKey = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function eligibleCard(bout) {
  return bout?.status === 'done' && decisions.has(bout.result?.type) && bout.sourceFight?.provider === 'boxing-data' && bout.rounds?.length === bout.roundsTotal;
}
export function cardTotals(bout) {
  return bout.rounds.reduce((total, round) => {
    for (const corner of ['red', 'blue']) total[corner] += Math.max(0, 10 - (round.winner !== corner && round.winner !== 'even' ? 1 : 0) - round.kd[corner] - round.ded[corner]);
    return total;
  }, { red: 0, blue: 0 });
}
export function normalizeOfficial(raw) {
  const first = raw?.fighters?.fighter_1, second = raw?.fighters?.fighter_2;
  if (raw?.status !== 'FINISHED') return { available: false, reason: 'Official result is not available yet.' };
  if (!decisions.has(raw.results?.outcome)) return { available: false, reason: 'Stoppages and non-decisions do not count towards judges’ agreement.' };
  const rounds = Number(raw.scheduled_rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 24 || !first?.full_name || !second?.full_name || !Array.isArray(raw.scores) || !raw.scores.length || raw.scores.length > 3) return { available: false, reason: 'Complete official scorecards are not available.' };
  const pairs = raw.scores.map(score => typeof score === 'string' && /^\d{1,3}\s*[-–]\s*\d{1,3}$/.test(score) ? score.split(/[-–]/).map(Number) : null);
  if (pairs.some(pair => !pair || pair.some(score => score < 0 || score > rounds * 10))) return { available: false, reason: 'Official scorecards could not be read.' };
  // The API does not label score sides. Pair the entire set using the majority
  // decision and the identified winner; never sort individual split cards.
  const majority = Math.sign(pairs.reduce((sum, [a, b]) => sum + Math.sign(a - b), 0));
  let reversed = false;
  if (raw.results.outcome === 'Draw') {
    if (pairs.some(([a, b]) => a !== b)) return { available: false, reason: 'The API does not identify which fighter owns each score in this draw.' };
  } else {
    if (typeof first.winner !== 'boolean' || typeof second.winner !== 'boolean' || first.winner === second.winner || !majority) return { available: false, reason: 'Official score sides could not be matched to the fighters.' };
    reversed = majority !== (first.winner ? 1 : -1);
    const votes = pairs.map(([a, b]) => Math.sign(a - b) * (reversed ? -1 : 1) * (first.winner ? 1 : -1));
    const valid = raw.results.outcome === 'UD' ? votes.every(v => v === 1) : raw.results.outcome === 'MD' ? votes.filter(v => v === 1).length === 2 && votes.includes(0) : votes.filter(v => v === 1).length === 2 && votes.includes(-1);
    if (!valid) return { available: false, reason: 'Official scores conflict with the published decision.' };
  }
  return { available: true, id: raw.id, rounds, outcome: raw.results.outcome,
    fighters: [first, second].map(f => ({ id: f.fighter_id || null, name: f.full_name })),
    scores: pairs.map(([a, b]) => reversed ? [b, a] : [a, b]),
    pairing: raw.results.outcome === 'Draw' ? 'Equal scores' : 'Paired using the official majority decision',
  };
}
export function compareCard(bout, official) {
  if (!eligibleCard(bout)) return { available: false, reason: 'Only complete decision cards selected from the schedule can be compared.' };
  if (!official?.available) return official || { available: false, reason: 'Official scores have not been checked yet.' };
  if (official.id !== bout.sourceFight.id || official.rounds !== bout.roundsTotal) return { available: false, reason: 'Scheduled rounds do not match the official fight.' };
  const matches = (corner, fighter) => bout.sourceFight[`${corner}FighterId`] ? bout.sourceFight[`${corner}FighterId`] === fighter.id : nameKey(bout[corner].name) === nameKey(fighter.name);
  const redIndex = official.fighters.findIndex(f => matches('red', f));
  const blueIndex = official.fighters.findIndex(f => matches('blue', f));
  if (redIndex < 0 || blueIndex < 0 || redIndex === blueIndex) return { available: false, reason: 'Scorecard fighters could not be matched to the official fight.' };
  const totals = cardTotals(bout);
  const scores = official.scores.map(pair => ({ red: pair[redIndex], blue: pair[blueIndex] }));
  const average = { red: scores.reduce((s, p) => s + p.red, 0) / scores.length, blue: scores.reduce((s, p) => s + p.blue, 0) / scores.length };
  const error = (Math.abs(totals.red - average.red) + Math.abs(totals.blue - average.blue)) / 2;
  return { available: true, scores, average, totals, error, agreement: Math.max(0, 100 * (1 - error / official.rounds)), pairing: official.pairing };
}
export function buildLeaderboard(users, officials) {
  return users.map(user => {
    const unique = new Map();
    const cards = user.history.filter(eligibleCard).sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id));
    for (const card of cards) if (!unique.has(card.sourceFight.id)) unique.set(card.sourceFight.id, card);
    const comparisons = [...unique.values()].map(card => compareCard(card, officials.get(card.sourceFight.id))).filter(c => c.available);
    return { id: user.id, name: user.name, fights: comparisons.length, agreement: comparisons.length ? comparisons.reduce((sum, c) => sum + c.agreement, 0) / comparisons.length : null };
  }).filter(u => u.fights).sort((a, b) => b.agreement - a.agreement || b.fights - a.fights || a.name.localeCompare(b.name)).map((u, i, rows) => {
    const firstEqual = rows.findIndex(r => Math.abs(r.agreement - u.agreement) < 0.0000001);
    return { ...u, rank: firstEqual + 1 };
  });
}
