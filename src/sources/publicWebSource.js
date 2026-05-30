const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');
const { cleanTitle, normalizeText, isGenericTitle, titleFromSlug } = require('../utils/text');
const { isShopeeUrl, passesKeywordFilter } = require('./offerExtractor');

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
    return new URL(String(url).trim(), baseUrl).toString();
  } catch {
    return String(url || '').trim();
  }
}

function pickBestFromSrcset(srcset, baseUrl) {
  if (!srcset) return '';
  const candidates = String(srcset)
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      const [url, descriptor] = part.split(/\s+/);
      const width = descriptor?.endsWith('w') ? Number(descriptor.replace('w', '')) : 0;
      const density = descriptor?.endsWith('x') ? Number(descriptor.replace('x', '')) : 0;
      return { url: normalizeImageUrl(url, baseUrl), width, density };
    })
    .filter((item) => item.url);
  candidates.sort((a, b) => (b.width || b.density || 0) - (a.width || a.density || 0));
  return candidates[0]?.url || '';
}

function isBadCollectedImageUrl(url) {
  const text = String(url || '').toLowerCase();
  if (!text) return true;
  if (!/^https?:\/\//i.test(text)) return true;
  return /logo|banner|placeholder|sprite|avatar|category|categoria|default|loading|transparent|pixel|blank|no-image|sem-imagem|favicon|icon/i.test(text);
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

function scoreImageForTitle(image, titleTokens) {
  const haystack = normalizeText(`${image.src || ''} ${image.alt || ''}`);
  let score = 0;
  for (const token of titleTokens) {
    if (token.length < 3) continue;
    if (haystack.includes(token)) score += 2;
  }
  return score;
}

function extractImageFromImgNode($, node, sourceUrl) {
  const srcset =
    node.attr('srcset') ||
    node.attr('data-srcset') ||
    node.attr('data-lazy-srcset') ||
    '';

  const srcsetUrl = pickBestFromSrcset(srcset, sourceUrl);
  const raw =
    srcsetUrl ||
    node.attr('data-zoom-image') ||
    node.attr('data-large-image') ||
    node.attr('data-original') ||
    node.attr('data-lazy-src') ||
    node.attr('data-src') ||
    node.attr('src') ||
    '';

  const src = normalizeImageUrl(raw, sourceUrl);
  if (isBadCollectedImageUrl(src)) return null;

  return {
    src,
    alt: node.attr('alt') || node.attr('title') || '',
    width: Number(node.attr('width') || 0),
    height: Number(node.attr('height') || 0),
    source: srcsetUrl ? 'card_srcset' : 'card_img'
  };
}

function findBestCardImage($, $element, sourceUrl, title) {
  const titleTokens = normalizeText(title || '')
    .split(' ')
    .filter((token) => token.length >= 3 && !['dia', 'ofertas', 'uol', 'ver', 'oferta', 'postado'].includes(token));

  let best = { src: '', score: -1, alt: '', source: '' };
  let firstValid = null;
  let current = $element;

  for (let depth = 0; depth < 6 && current && current.length; depth += 1) {
    const container = current.is('article, li, div, section') ? current : current.closest('article, li, div, section');
    const scope = container && container.length ? container : current;

    scope.find('img').each((_, img) => {
      const image = extractImageFromImgNode($, $(img), sourceUrl);
      if (!image) return;
      if (!firstValid) firstValid = image;
      const score = scoreImageForTitle(image, titleTokens) + (image.width >= 250 ? 1 : 0) + (image.height >= 250 ? 1 : 0);
      if (score > best.score) {
        best = { ...image, score };
      }
    });

    if (best.score >= 2 || firstValid) break;
    current = current.parent();
  }

  return best.src || firstValid?.src || '';
}

function pickBestImageForTitle($, title, sourceUrl) {
  const tokens = normalizeText(title)
    .split(' ')
    .filter((token) => token.length >= 3 && !['dia', 'ofertas', 'uol'].includes(token));

  const images = [];
  $('img').each((_, img) => {
    const image = extractImageFromImgNode($, $(img), sourceUrl);
    if (image) images.push(image);
  });

  if (!images.length) return '';
  const ranked = images
    .map((image) => ({ ...image, score: scoreImageForTitle(image, tokens) }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.src || '';
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
  const candidates = [];

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const url = absolutizeUrl(href, sourceUrl);
    if (!url || !isShopeeUrl(url)) return;

    const $card = $(element).closest('article, li, div, section');
    const parentText = $card.text().replace(/\s+/g, ' ').trim();
    const title = cleanTitle($(element).attr('title') || $(element).text() || parentText);
    const pageImage = pickBestImageForTitle($, title, sourceUrl);
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
      imageSource: item.imageUrl ? 'category_card_candidate' : '',
      imageConfidence: item.imageUrl ? 50 : 0,
      rawText: item.text || '',
      cardText: item.cardText || '',
      sourceUrl,
      reviewSourceUrl: item.url
    });
  }

  const withImage = offers.filter((offer) => offer.imageUrl).length;
  console.log(`[Coletor] Página ${sourceUrl}: ${offers.length} ofertas aproveitáveis. Com imagem de card: ${withImage}.`);
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
