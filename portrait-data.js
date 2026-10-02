export const portraitNameKey = name => String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
export const initials = name => String(name).trim().split(/\s+/).filter(Boolean).filter((_, i, words) => i === 0 || i === words.length - 1).map(word => [...word][0]).join('').toLocaleUpperCase().slice(0, 4) || '?';
const values = (entity, property) => (entity?.claims?.[property] || []).filter(claim => claim.rank !== 'deprecated').map(claim => claim.mainsnak?.datavalue?.value);
export function matchBoxer(name, entities) {
  const key = portraitNameKey(name);
  const matches = Object.values(entities || {}).filter(entity => {
    const names = [entity.labels?.en?.value, ...(entity.aliases?.en || []).map(alias => alias.value)].filter(Boolean);
    return values(entity, 'P31').some(value => value?.id === 'Q5') &&
      (values(entity, 'P106').some(value => value?.id === 'Q11338576') || values(entity, 'P641').some(value => value?.id === 'Q32112')) &&
      names.some(label => portraitNameKey(label) === key);
  });
  if (matches.length !== 1) return null;
  const entity = matches[0];
  const images = (entity.claims?.P18 || []).filter(claim => claim.rank !== 'deprecated' && typeof claim.mainsnak?.datavalue?.value === 'string');
  const preferred = images.find(claim => claim.rank === 'preferred') || images[0];
  return preferred ? { id: entity.id, file: preferred.mainsnak.datavalue.value } : null;
}
export function plainCredit(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, code) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[code]).replace(/\s+/g, ' ').trim().slice(0, 500);
}
export function safeImageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname) && url.pathname.startsWith('/wikipedia/commons/') && !url.username && !url.password && !url.port ? url.href : null; } catch { return null; }
}
export function commonsPortrait(info, file, entityId) {
  const meta = info?.extmetadata || {};
  const license = plainCredit(meta.LicenseShortName?.value);
  const licenseUrl = String(meta.LicenseUrl?.value || '').replace(/^\/\//, 'https://');
  const cc = license.match(/^CC (BY(?:-SA)?) ([1-4]\.0)$/);
  const allowed = cc ? licenseUrl.replace(/\/$/, '') === `https://creativecommons.org/licenses/${cc[1].toLowerCase()}/${cc[2]}` :
    ['CC0', 'CC0 1.0'].includes(license) && /^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/.test(licenseUrl);
  const author = plainCredit(meta.Attribution?.value || meta.Artist?.value);
  const credit = plainCredit(meta.Credit?.value);
  let sourceUrl;
  try { const url = new URL(info.descriptionurl); if (url.protocol !== 'https:' || url.hostname !== 'commons.wikimedia.org' || !url.pathname.startsWith('/wiki/File:')) return null; sourceUrl = url.href; } catch { return null; }
  const imageUrl = safeImageUrl(info.thumburl);
  if (!allowed || !author || !imageUrl || !['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)) return null;
  return { available: true, entityId, imageUrl, sourceUrl, title: plainCredit(meta.ObjectName?.value || file), author,
    credit: /^own work$/i.test(credit) ? '' : credit, license, licenseUrl };
}
