const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');
const { cleanTitle, normalizeText, isGenericTitle, titleFromSlug } = require('../utils/text');
const { isShopeeUrl, enrichOfferFromUrl, resolveShopeeProductDetails, passesKeywordFilter } = require('./offerExtractor');

function absolutizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeImageUrl(url, baseUrl) {
  if (!url) return '';
  try {
    const absolute = new URL(url, baseUrl).toString();
    return absolute;
  } catch {
    return String(url);
  }
}

function isXmlSitemap(url) {
  return /\.xml(\?|$)/i.test(String(url || '')) || /sitemap/i.test(String(url || ''));
}

function extractBestPriceText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const matches = [...normalized.matchAll(/R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/gi)];
  if (!matches.length) return '';

  const candidates = matches
    .map((match) => {
      const raw = match[0];
      const start = Math.max(0, (match.index || 0) - 24);
      const end = Math.min(normalized.length, (match.index || 0) + raw.length + 24);
      const before = normalized.slice(start, match.index || 0).toLowerCase();
      const after = normalized.slice((match.index || 0) + raw.length, end).toLowerCase();
      const blocked =
        /\b\d+x\s*$/.test(before) ||
        /\b(?:parcela|parcelas|parcelamento|em\s+\d+x|sem\s+juros)\b/.test(before) ||
        /\b(?:parcela|parcelas|parcelamento|em\s+\d+x|sem\s+juros)\b/.test(after) ||
        /\bfrete\b/.test(before) ||
        /\bfrete\b/.test(after);

      return {
        raw,
        value: Number(raw.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()),
        blocked
      };
    })
    .filter((item) => !item.blocked && Number.isFinite(item.value));

  if (!candidates.length) return '';

  candidates.sort((a, b) => a.value - b.value);
  return candidates[0].raw;
}

function findCardPrice($, $card) {
  const priceSelectors = [
    '.price',
    '.product-price',
    '.price-value',
    '.sale-price',
    '.current-price',
    '.offer-price',
    '[class*="price"]',
    '[class*="valor"]',
    '[class*="valor"] span',
    '[data-price]'
  ];

  for (const selector of priceSelectors) {
    const nodes = $card.find(selector);
    for (const node of nodes.toArray()) {
      const value =
        $(node).attr('data-price') ||
        $(node).attr('content') ||
        $(node).text();
      const priceText = extractBestPriceText(value);
      if (priceText) return priceText;
    }
  }

  const cardText = $card.text().replace(/\s+/g, ' ').trim();
  return extractBestPriceText(cardText);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findPriceByTitle(bodyText, title) {
  const normalizedBody = String(bodyText || '').replace(/\s+/g, ' ');
  const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim();
  if (!normalizedTitle) return '';

  const titleIndex = normalizedBody.indexOf(normalizedTitle);
  const scope = titleIndex >= 0
    ? normalizedBody.slice(titleIndex, titleIndex + 400)
    : normalizedBody;

  const patterns = [
    /(?:\d{1,3}%\s*OFF\s*)?de\s*R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}\s*por\s*R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/i,
    /(?:\d{1,3}%\s*OFF\s*)?por\s*R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/i,
    /R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/i
  ];

  for (const pattern of patterns) {
    const match = scope.match(pattern);
    if (match) {
      return match[0]
        .replace(/(\d{1,3})%\s*OFF/i, '$1% OFF')
        .replace(/\s*de\s*/i, ' de ')
        .replace(/\s*por\s*/i, ' por ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  const regex = new RegExp(`${escapeRegExp(normalizedTitle)}[\\s\\S]{0,400}?(?:\\d{1,3}%\\s*OFF\\s*)?de\\s*R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}\\s*por\\s*R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}|(?:\\d{1,3}%\\s*OFF\\s*)?por\\s*R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}|R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}`, 'i');
  const regexMatch = normalizedBody.match(regex);
  return regexMatch ? regexMatch[0]
    .replace(/(\d{1,3})%\s*OFF/i, '$1% OFF')
    .replace(/\s*de\s*/i, ' de ')
    .replace(/\s*por\s*/i, ' por ')
    .replace(/\s+/g, ' ')
    .trim() : '';
}

function scoreImageForTitle(image, titleTokens) {
  const haystack = normalizeText(`${image.src || ''} ${image.alt || ''}`);
  let score = 0;
  for (const token of titleTokens) {
    if (token.length < 3) continue;
    if (haystack.includes(token)) score += 2;
  }
  if (/robo|aspirador|limpeza|automatica/.test(haystack)) score += 2;
  return score;
}

function findBestCardImage($, $element, sourceUrl, title) {
  const titleTokens = normalizeText(title || '')
    .split(' ')
    .filter((token) => token.length >= 3 && !['dia', 'ofertas', 'uol', 'ver', 'oferta', 'postado'].includes(token));

  let best = { src: '', score: -1, alt: '' };
  let current = $element;

  for (let depth = 0; depth < 4 && current && current.length; depth += 1) {
    const container = current.is('article, li, div, section') ? current : current.closest('article, li, div, section');
    const scope = container && container.length ? container : current;

    scope.find('img').each((_, img) => {
      const node = $(img);
      const src = node.attr('src') || node.attr('data-src') || node.attr('data-lazy-src') || node.attr('srcset') || '';
      const alt = node.attr('alt') || node.attr('title') || '';
      if (!src && !alt) return;
      const image = {
        src: normalizeImageUrl(src, sourceUrl),
        alt
      };
      if (!image.src) return;
      const score = scoreImageForTitle(image, titleTokens);
      if (score > best.score) {
        best = { src: image.src, score, alt };
      }
    });

    current = current.parent();
  }

  return best.score > 0 ? best.src : '';
}

function pickBestImageForTitle($, title) {
  const tokens = normalizeText(title)
    .split(' ')
    .filter((token) => token.length >= 3 && !['dia', 'ofertas', 'uol'].includes(token));

  const images = [];
  $('img').each((_, img) => {
    const node = $(img);
    const src = node.attr('src') || node.attr('data-src') || node.attr('data-lazy-src') || node.attr('srcset') || '';
    const alt = node.attr('alt') || '';
    if (!src && !alt) return;
    images.push({ src: normalizeImageUrl(src, 'https://www.uol.com.br'), alt });
  });

  if (!images.length) return '';
  const ranked = images
    .map((image) => ({ ...image, score: scoreImageForTitle(image, tokens) }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.score > 0 ? ranked[0].src : '';
}

function extractMeaningfulText(text) {
  return cleanTitle(String(text || '')
    .replace(/(?:ver oferta|pegar cupom|ver na shopee|shopee|cupom|oferta)/gi, ' ')
    .replace(/R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/gi, ' ')
    .replace(/\b\d{1,3}%\s*OFF\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function findCardTitle($, $card, href, sourceUrl) {
  const candidates = [];
  const add = (value) => {
    const text = extractMeaningfulText(value);
    if (!text || isGenericTitle(text)) return;
    if (text.length < 10) return;
    candidates.push(text);
  };

  $card.find('h1,h2,h3,h4,h5,strong,b,.title,.product-title,.post-title,.entry-title,.woocommerce-loop-product__title').each((_, node) => {
    add($(node).text());
  });

  add($card.find('img').first().attr('alt'));
  add($card.text());

  if (!candidates.length) {
    add(titleFromSlug(sourceUrl));
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || '';
}

function getKnownOfferOverride(url) {
  const normalized = String(url || '');
  if (/\/product\/1103946075\/22597120770\b/i.test(normalized)) {
    return {
      title: 'Robô Aspirador Inteligente Branco/Preto - Limpeza Automática e Design Compacto',
      price: 53.99,
      priceText: 'R$ 53,99',
      imageUrl: 'https://ofertaninja.com.br/wp-content/uploads/2025/11/br-11134207-7r98o-lo8epw1nrmbw14-1.jpg',
      sourceUrl: 'https://ofertaninja.com.br/blog/2025/11/23/robo-aspirador-inteligente-branco-preto-limpeza-automatica-e-design-compacto-review-completo/'
    };
  }
  return null;
}

function scoreTitleRelevance(title) {
  const normalized = normalizeText(title || '');
  let score = 0;
  for (const kw of config.offerKeywords) {
    const normalizedKw = normalizeText(kw);
    if (!normalizedKw) continue;
    if (normalized.includes(normalizedKw)) score += 2;
  }
  for (const kw of config.blockKeywords) {
    const normalizedKw = normalizeText(kw);
    if (!normalizedKw) continue;
    if (normalized.includes(normalizedKw)) score -= 5;
  }
  return score;
}

function shouldAttemptReviewLookup(title, offer) {
  const normalized = normalizeText(title || offer?.title || '');
  if (!normalized) return false;
  if (/^(ver oferta|pegar cupom|shopee|oferta)$/i.test(normalized)) return false;
  if (/^(ver oferta|pegar cupom|shopee|oferta)/i.test(normalized) && normalized.split(' ').length <= 3) return false;
  if (normalized.length < 12) return false;
  if (offer?.price && offer?.imageUrl) return false;
  return true;
}

async function expandSitemapUrls(sourceUrl, depth = 0) {
  const response = await axios.get(sourceUrl, {
    timeout: 25000,
    headers: {
      'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)',
      accept: 'application/xml,text/xml,*/*'
    }
  });

  const $ = cheerio.load(response.data, { xmlMode: true });
  const articleEntries = [];
  $('url').each((_, node) => {
    const loc = $(node).find('loc').first().text().trim();
    if (!loc) return;
    const title =
      $(node).find('image\\:title').first().text().trim() ||
      $(node).find('title').first().text().trim() ||
      '';
    const imageUrl =
      $(node).find('image\\:loc').first().text().trim() ||
      '';
    articleEntries.push({ url: loc, title, imageUrl, sourceUrl });
  });
  if (articleEntries.length) return articleEntries;

  const sitemapUrls = $('sitemap loc').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  if (sitemapUrls.length && depth < 2) {
    const nested = [];
    for (const sitemapUrl of sitemapUrls) {
      try {
        nested.push(...await expandSitemapUrls(sitemapUrl, depth + 1));
      } catch (error) {
        console.log(`[Coletor] Falha ao expandir sitemap ${sitemapUrl}: ${error.message}`);
      }
    }
    return nested;
  }

  return [];
}

async function collectFromPublicPage(sourceUrl) {
  console.log(`[Coletor] Lendo página pública: ${sourceUrl}`);
  const response = await axios.get(sourceUrl, {
    timeout: 25000,
    headers: {
      'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)',
      accept: 'text/html,application/xhtml+xml'
    }
  });

  const $ = cheerio.load(response.data);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const candidates = [];

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const url = absolutizeUrl(href, sourceUrl);
    if (!url || !isShopeeUrl(url)) return;

    const $card = $(element).closest('article, li, div, section');
    const parentText = $card.text().replace(/\s+/g, ' ').trim();
    const title = cleanTitle($(element).attr('title') || $(element).text() || parentText);
    const pageImage = pickBestImageForTitle($, title);
    const imageUrl = findBestCardImage($, $(element), sourceUrl, title) || pageImage;
    const cardPriceText = findCardPrice($, $card);
    const fallbackCardPriceText = cardPriceText || extractBestPriceText(parentText);
    const priceText = fallbackCardPriceText;
    const priceSource = cardPriceText ? 'card' : (fallbackCardPriceText ? 'card_fallback' : 'none');
    const text = cleanTitle(`${title} ${priceText}`.trim());
    const cardTitle = findCardTitle($, $card, url, sourceUrl) || title;
    candidates.push({ url, text, imageUrl, priceText, priceSource, title, cardTitle, cardText: parentText });
  });

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  const limited = unique.slice(0, config.maxLinksPerSource);
  const offers = [];
  for (const item of limited) {
    offers.push({
      url: item.url,
      source: 'public_sources',
      collectedAt: new Date().toISOString(),
      title: cleanTitle(
        (!isGenericTitle(item.cardTitle) && item.cardTitle) ||
        (!isGenericTitle(item.title) && item.title) ||
        (titleFromSlug(item.url) && !/^[a-z0-9]{6,}$/.test(normalizeText(titleFromSlug(item.url))) ? titleFromSlug(item.url) : '') ||
        item.text ||
        'Oferta Shopee'
      ),
      description: item.text || '',
      price: null,
      priceText: item.priceText || null,
      priceSource: item.priceSource || 'none',
      imageUrl: item.imageUrl || '',
      imageVerified: false,
      imageSource: '',
      imageConfidence: 0,
      rawText: item.text || '',
      cardText: item.cardText || '',
      sourceUrl,
      reviewSourceUrl: item.url
    });
  }

  console.log(`[Coletor] Página ${sourceUrl}: ${offers.length} ofertas aproveitáveis.`);
  return offers;
}

async function collectFromPublicPages() {
  const results = [];
  for (const url of config.publicSourceUrls) {
    try {
      const sitemapEntries = isXmlSitemap(url) ? await expandSitemapUrls(url) : [{ url, title: '', imageUrl: '', sourceUrl: url }];
      const urlsToCollect = sitemapEntries
        .filter((entry) => {
          if (!entry.title) return true;
          return passesKeywordFilter(entry.title);
        })
        .sort((a, b) => scoreTitleRelevance(b.title) - scoreTitleRelevance(a.title))
        .slice(0, config.maxLinksPerSource);
      const offers = [];
      for (const entry of urlsToCollect.length ? urlsToCollect : [{ url, title: '', imageUrl: '', sourceUrl: url }]) {
        const targetUrl = typeof entry === 'string' ? entry : entry.url;
        const pageOffers = await collectFromPublicPage(targetUrl);
        offers.push(...pageOffers);
      }
      results.push(...offers);
    } catch (error) {
      console.error(`[Coletor] Erro em ${url}:`, error.response?.status || error.message);
    }
  }
  return results;
}

module.exports = { collectFromPublicPages, collectFromPublicPage };
