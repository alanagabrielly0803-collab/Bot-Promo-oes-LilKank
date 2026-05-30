function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(text) {
  const match = String(text || '').match(/R\$\s*([0-9.]+,[0-9]{2})/i);
  if (!match) return null;
  const value = Number(match[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\|.*$/g, '')
    .trim()
    .slice(0, 180);
}

function isGenericTitle(value) {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  return [
    'ver oferta',
    'pegar cupom',
    'oferta',
    'shopee',
    'veja mais',
    'veja oferta'
  ].some((phrase) => normalized === phrase || normalized.startsWith(`${phrase} `));
}

function titleFromSlug(url) {
  try {
    const parsed = new URL(String(url || ''));
    const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (!slug) return '';
    return cleanTitle(slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (match) => match.toUpperCase()));
  } catch {
    return '';
  }
}

function compactKeywords(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 3)
    .filter((token, index, list) => list.indexOf(token) === index);
}

module.exports = { normalizeText, parsePrice, cleanTitle, isGenericTitle, titleFromSlug, compactKeywords };
