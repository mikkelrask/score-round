export const fighterNameKey = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const text = value => typeof value === 'string' ? value.trim().slice(0,200) : '';
const integer = (value, max=10000) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
export function normalizeFighter(raw) {
  if (!raw || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id || '') || !text(raw.name)) return null;
  const wins=integer(raw.stats?.wins), losses=integer(raw.stats?.losses), draws=integer(raw.stats?.draws);
  return { id: raw.id, name: text(raw.name), nickname: text(raw.nickname || raw.alias), nationality: text(raw.nationality), stance: text(raw.stance),
    height: text(raw.height), reach: text(raw.reach), age: integer(raw.age,120), birthYear: Number.isInteger(raw.birth_year) && raw.birth_year >= 1850 && raw.birth_year <= new Date().getUTCFullYear() ? raw.birth_year : null,
    division: text(raw.division?.name), debut: text(raw.debut), record: [wins,losses,draws].every(v=>v!==null) ? {wins,losses,draws} : null,
    knockouts: integer(raw.stats?.ko_wins), careerRounds: integer(raw.stats?.total_rounds),
    updatedAt: typeof raw.updated_at === 'string' && Number.isFinite(Date.parse(raw.updated_at)) ? raw.updated_at : null };
}
export function matchFighter(name, records) {
  const key=fighterNameKey(name); const matches=records.filter(record=>[record.name,record.nickname,record.alias].some(value=>fighterNameKey(value)===key));
  return matches.length===1 ? normalizeFighter(matches[0]) : null;
}
