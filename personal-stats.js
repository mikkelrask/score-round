import { cardTotals, eligibleCard, compareCard } from './judging.js';
export function personalStats(history, officials = new Map()) {
  const rounds = history.flatMap(card => card.rounds);
  const decisions = history.filter(card => ['UD','MD','SD','Draw'].includes(card.result?.type) && card.rounds.length === card.roundsTotal);
  const margins = decisions.map(card => { const total = cardTotals(card); return Math.abs(total.red - total.blue); });
  const unique = new Map();
  for (const card of history.filter(eligibleCard).sort((a,b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id))) if (!unique.has(card.sourceFight.id)) unique.set(card.sourceFight.id, card);
  const comparisons = [...unique.values()].flatMap(card => {
    const comparison = compareCard(card, officials.get(card.sourceFight.id));
    return comparison.available ? [{ date: card.endedAt, fight: `${card.red.name} vs ${card.blue.name}`, agreement: comparison.agreement }] : [];
  }).sort((a,b) => a.date.localeCompare(b.date));
  const months = new Map();
  for (const point of comparisons) {
    const month = new Date(point.date).toISOString().slice(0,7);
    if (!months.has(month)) months.set(month, []); months.get(month).push(point.agreement);
  }
  return { fights: history.length, rounds: rounds.length, decisions: decisions.length,
    closeCards: margins.filter(margin => margin <= 2).length, levelCards: margins.filter(margin => margin === 0).length,
    recordedDraws: history.filter(card => card.result?.type === 'Draw').length,
    stoppages: history.filter(card => ['KO','TKO','RTD','DQ'].includes(card.result?.type)).length,
    evenRounds: rounds.filter(round => round.winner === 'even').length,
    knockdowns: rounds.reduce((sum,r) => sum + r.kd.red + r.kd.blue, 0), deductions: rounds.reduce((sum,r) => sum + r.ded.red + r.ded.blue, 0),
    averageMargin: margins.length ? margins.reduce((a,b) => a+b,0)/margins.length : null,
    rankedFights: comparisons.length, agreement: comparisons.length ? comparisons.reduce((sum,p) => sum+p.agreement,0)/comparisons.length : null,
    trend: [...months].map(([month, points]) => ({month, fights: points.length, agreement: points.reduce((a,b)=>a+b,0)/points.length})).slice(-12),
    comparisons: comparisons.slice(-10).reverse() };
}
