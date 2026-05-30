const { getLinkPreview } = require('link-preview-js');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, parsePrice, cleanTitle, isGenericTitle, titleFromSlug, compactKeywords } = require('../utils/text');
const config = require('../config');

function isShopeeUrl(url) {
  return /https?:\/\/(?:(?:www|s)\.)?shopee\.com\.br\//i.test(String(url || '')) ||
    /https?:\/\/s\.shopee\.com\.br\//i.test(String(url || '')) ||
    /https?:\/\/(?:www\.)?shopee\.com\//i.test(String(url || ''));
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const keep = new URLSearchParams();
    for (const key of ['sp_atk']) {
      if (parsed.searchParams.has(key)) keep.set(key, parsed.searchParams.get(key));
    }
    parsed.search = keep.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

function passesKeywordFilter(text) {
  const normalized = normalizeText(text);
  const allow = config.offerKeywords.length === 0 || config.offerKeywords.some((kw) => normalized.includes(normalizeText(kw)));
  const block = config.blockKeywords.some((kw) => normalized.includes(normalizeText(kw)));
  return allow && !block;
}

function passesPriceFilter(price) {
  if (price == null) return true;
  return price >= config.minPrice && price <= config.maxPrice;
}

function parseLastPrice(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const dePorMatch = normalized.match(/de\s*(R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}).{0,30}?por\s*(R\$\s*\d{1,3}(?:\.\d{3})*,\d{2})/i);
  if (dePorMatch) {
    return parsePrice(dePorMatch[2]);
  }

  const couponMatch = normalized.match(/(R\$\s*\d{1,3}(?:\.\d{3})*,\d{2})(?=\s*(?:com\s+cupom|ou\b))/i);
  if (couponMatch) {
    return parsePrice(couponMatch[1]);
  }

  const matches = [...normalized.matchAll(/R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/gi)];
  if (!matches.length) return null;

  const validMatches = matches.filter((match) => {
    const start = Math.max(0, (match.index || 0) - 20);
    const before = normalized.slice(start, match.index || 0).toLowerCase();
    const after = normalized.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 20).toLowerCase();

    if (/\b\d+x\s*$/.test(before)) return false;
    if (/\b(?:parcela|parcelas|parcelamento|em\s+\d+x|sem\s+juros)\b/.test(before)) return false;
    if (/\b(?:parcela|parcelas|parcelamento|em\s+\d+x|sem\s+juros)\b/.test(after)) return false;
    if (/\bfrete\b/.test(before) || /\bfrete\b/.test(after)) return false;
    if (/\bou\b/.test(after) && !/com\s+cupom/.test(after)) return true;
    return true;
  });

  const chosen = validMatches[0];
  return chosen ? parsePrice(chosen[0]) : null;
}

function normalizePriceText(price) {
  if (price == null || Number.isNaN(Number(price))) return '';
  return `R$ ${Number(price).toFixed(2).replace('.', ',')}`;
}

function absolutizeImageUrl(url, baseUrl) {
  if (!url) return '';
  const first = String(url).split(',')[0].trim().split(/\s+/)[0];
  if (!first) return '';
  try {
    return new URL(first, baseUrl).toString();
  } catch {
    return String(first);
  }
}

function pickBestFromSrcset(srcset, baseUrl) {
  if (!srcset) return '';
  const candidates = String(srcset)
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      const [url, size] = part.split(/\s+/);
      const width = size && size.endsWith('w') ? Number(size.replace('w', '')) : 0;
      return { url: absolutizeImageUrl(url, baseUrl), width };
    })
    .filter((item) => item.url);
  candidates.sort((a, b) => b.width - a.width);
  return candidates[0]?.url || '';
}

function normalizeImageValue(value, baseUrl) {
  if (!value) return '';
  if (typeof value === 'string') {
    if (value.includes(',')) return pickBestFromSrcset(value, baseUrl);
    return absolutizeImageUrl(value, baseUrl);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = normalizeImageValue(item, baseUrl);
      if (result) return result;
    }
  }
  if (typeof value === 'object') {
    return absolutizeImageUrl(value.url || value.contentUrl || value.thumbnailUrl || value.image || '', baseUrl);
  }
  return '';
}

function scorePageImageCandidate(candidate = {}, title = '') {
  const sourceScores = {
    jsonld_product: 95,
    og_image: 88,
    twitter_image: 82,
    dom_main_image: 68,
    playwright_rendered_image: 75,
    google_image: 60,
    shopee_meta: 58
  };

  const imageUrl = String(candidate.imageUrl || '');
  const alt = normalizeText(candidate.alt || candidate.imageAlt || '');
  const titleText = normalizeText(title || '');
  const tokens = titleText
    .split(' ')
    .filter((token) => token.length >= 4 && !['postado', 'oferta', 'shopee', 'cupom'].includes(token));

  let score = sourceScores[candidate.imageSource] || 0;

  if (candidate.width >= 300) score += 5;
  if (candidate.width >= 600) score += 10;
  if (candidate.height >= 300) score += 5;
  if (candidate.height >= 600) score += 10;
  if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(imageUrl)) score += 8;
  if (/logo|banner|placeholder|sprite|avatar/.test(normalizeText(imageUrl))) score -= 80;

  for (const token of tokens) {
    if (alt.includes(token)) score += 6;
    if (normalizeText(imageUrl).includes(token)) score += 3;
  }

  return Math.max(0, Math.min(100, score));
}

function buildGoogleImageQuery({ title = '', description = '', contextText = '' }) {
  const source = cleanTitle(`${title} ${description} ${contextText}`);
  const tokens = compactKeywords(source)
    .filter((token) => !['oferta', 'promo', 'promocao', 'shopee', 'produto', 'kit'].includes(token))
    .slice(0, 8);
  return tokens.join(' ').trim();
}

function scoreGoogleImageResult(item, tokens) {
  const haystack = normalizeText([
    item?.title || '',
    item?.snippet || '',
    item?.image?.contextLink || '',
    item?.link || ''
  ].join(' '));
  let score = 0;
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (haystack.includes(token)) score += 3;
  }
  if (/googleusercontent\.com|ggpht\.com|encrypted-tbn/.test(item?.link || '')) score += 1;
  if (item?.image?.thumbnailLink) score += 1;
  return score;
}

async function resolveGoogleProductImage({ title = '', description = '', contextText = '' } = {}) {
  if (!config.googleImageSearchApiKey || !config.googleImageSearchCx) return null;

  const query = buildGoogleImageQuery({ title, description, contextText });
  if (!query) return null;

  const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
    timeout: 15000,
    params: {
      key: config.googleImageSearchApiKey,
      cx: config.googleImageSearchCx,
      q: query,
      searchType: 'image',
      num: 5,
      safe: 'active',
      imgType: 'photo'
    },
    headers: {
      'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
    }
  });

  const items = Array.isArray(response.data?.items) ? response.data.items : [];
  if (!items.length) return null;

  const tokens = compactKeywords(query);
  const ranked = items
    .map((item) => ({ ...item, score: scoreGoogleImageResult(item, tokens) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 2) return null;

  return {
    imageUrl: best.link || best.image?.thumbnailLink || '',
    imageTitle: best.title || '',
    imageSourceUrl: best.image?.contextLink || best.link || '',
    query,
    score: best.score
  };
}

function findProductJsonLdImage($, pageUrl) {
  const jsonLdObjects = extractJsonLdObjects($);
  for (const entry of jsonLdObjects) {
    const nodes = [];
    if (entry && typeof entry === 'object') nodes.push(entry);
    if (entry && typeof entry === 'object' && Array.isArray(entry['@graph'])) nodes.push(...entry['@graph']);
    for (const node of nodes) {
      const type = node?.['@type'];
      const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      if (!isProduct) continue;
      const image = normalizeImageValue(node.image || node?.offers?.image || '', pageUrl);
      if (image) {
        return {
          imageUrl: image,
          imageSource: 'jsonld_product',
          confidence: 95
        };
      }
    }
  }
  return null;
}

function findMetaImage($, pageUrl) {
  const selectors = [
    ['meta[property="og:image"]', 'og_image', 90],
    ['meta[property="og:image:secure_url"]', 'og_image', 90],
    ['meta[name="twitter:image"]', 'twitter_image', 85],
    ['meta[name="twitter:image:src"]', 'twitter_image', 85]
  ];

  for (const [selector, source, confidence] of selectors) {
    const content = $(selector).first().attr('content') || '';
    const imageUrl = normalizeImageValue(content, pageUrl);
    if (imageUrl) return { imageUrl, imageSource: source, confidence };
  }

  return null;
}

function findDomImage($, pageUrl, productTitle = '') {
  const titleTokens = normalizeText(productTitle)
    .split(' ')
    .filter((token) => token.length >= 4 && !['postado', 'h', 'oferta', 'shopee'].includes(token));

  const candidates = [];
  $('img').each((_, img) => {
    const node = $(img);
    const src = node.attr('srcset') ||
      node.attr('data-srcset') ||
      node.attr('data-zoom-image') ||
      node.attr('data-large-image') ||
      node.attr('data-original') ||
      node.attr('data-lazy-src') ||
      node.attr('data-src') ||
      node.attr('src') ||
      '';
    const imageUrl = normalizeImageValue(src, pageUrl);
    if (!imageUrl) return;
    const alt = normalizeText(`${node.attr('alt') || ''} ${node.attr('title') || ''}`);
    const candidate = {
      imageUrl,
      alt,
      title: productTitle,
      imageSource: 'dom_main_image'
    };
    const score = scorePageImageCandidate(candidate, productTitle);
    candidates.push({
      imageUrl,
      imageSource: 'dom_main_image',
      confidence: Math.min(score, 85),
      alt
    });
  });

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0] || null;
}

async function validateImageUrl(imageUrl) {
  if (!imageUrl) return null;
  try {
    const response = await axios.get(imageUrl, {
      timeout: 12000,
      responseType: 'arraybuffer',
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)',
        accept: 'image/*,*/*'
      },
      validateStatus: (status) => status >= 200 && status < 500
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const size = response.data?.byteLength || 0;
    if (!contentType.startsWith('image/')) return null;
    if (size < 8000) return null;
    return {
      ok: true,
      contentType,
      size
    };
  } catch {
    return null;
  }
}

async function extractImagesWithPlaywright(pageUrl, title = '') {
  let browser = null;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      timeout: config.playwrightTimeoutMs
    });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      viewport: { width: 1365, height: 1365 }
    });

    const networkImages = [];
    page.on('response', async (response) => {
      try {
        if (response.request().resourceType() === 'image') {
          networkImages.push(response.url());
        }
      } catch {
        // ignore
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.playwrightTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const domImages = await page.evaluate(() => Array.from(document.querySelectorAll('img')).map((img) => ({
      src: img.currentSrc || img.src || '',
      srcset: img.getAttribute('srcset') || '',
      dataSrc: img.getAttribute('data-src') || '',
      dataSrcset: img.getAttribute('data-srcset') || '',
      dataOriginal: img.getAttribute('data-original') || '',
      dataLazySrc: img.getAttribute('data-lazy-src') || '',
      dataZoomImage: img.getAttribute('data-zoom-image') || '',
      dataLargeImage: img.getAttribute('data-large-image') || '',
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || '',
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0
    })));

    await browser.close();

    const candidates = [];
    for (const img of domImages) {
      const sources = [
        img.dataZoomImage,
        img.dataLargeImage,
        img.dataOriginal,
        img.dataLazySrc,
        img.dataSrcset,
        img.dataSrc,
        img.srcset,
        img.src
      ];
      for (const raw of sources) {
        const imageUrl = normalizeImageValue(raw, pageUrl);
        if (!imageUrl) continue;
        const candidate = {
          imageUrl,
          alt: `${img.alt || ''} ${img.title || ''}`.trim(),
          title,
          width: Number(img.width) || 0,
          height: Number(img.height) || 0,
          imageSource: 'playwright_rendered_image'
        };
        candidate.confidence = scorePageImageCandidate(candidate, title);
        candidates.push(candidate);
        break;
      }
    }

    for (const imageUrl of networkImages) {
      if (!imageUrl) continue;
      const candidate = {
        imageUrl,
        alt: '',
        title,
        width: 0,
        height: 0,
        imageSource: 'playwright_rendered_image'
      };
      candidate.confidence = scorePageImageCandidate(candidate, title);
      candidates.push(candidate);
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0] || null;
  } catch (error) {
    console.warn('[Coletor] Falha ao extrair imagem com Playwright:', error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function resolveVerifiedPageImage(page, pageUrl, title = '') {
  const jsonLd = findProductJsonLdImage(page, pageUrl);
  const meta = findMetaImage(page, pageUrl);
  const dom = findDomImage(page, pageUrl, title);

  const ordered = [jsonLd, meta, dom].filter(Boolean);
  for (const candidate of ordered) {
    const validation = await validateImageUrl(candidate.imageUrl);
    const confidence = scorePageImageCandidate(candidate, title);
    if (validation && confidence >= config.imageMinConfidence) {
      return {
        imageUrl: candidate.imageUrl,
        imageSource: candidate.imageSource,
        imageConfidence: confidence,
        imageVerified: true,
        imageValidation: validation
      };
    }
  }

  if (config.imageExtractionMode !== 'page_only') {
    const playwrightCandidate = await extractImagesWithPlaywright(pageUrl, title);
    if (playwrightCandidate) {
      const validation = await validateImageUrl(playwrightCandidate.imageUrl);
      const confidence = scorePageImageCandidate(playwrightCandidate, title);
      if (validation && confidence >= config.imageMinConfidence) {
        return {
          imageUrl: playwrightCandidate.imageUrl,
          imageSource: playwrightCandidate.imageSource,
          imageConfidence: confidence,
          imageVerified: true,
          imageValidation: validation
        };
      }
    }
  }

  return {
    imageUrl: '',
    imageSource: 'none',
    imageConfidence: 0,
    imageVerified: false
  };
}

function decodeDuckDuckGoUrl(href) {
  if (!href) return '';
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return parsed.toString();
  } catch {
    return String(href);
  }
}

function extractJsonLdObjects($) {
  const objects = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        objects.push(...parsed);
      } else {
        objects.push(parsed);
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });
  return objects;
}

function extractOfferFromJsonLd($, pageUrl) {
  const jsonLdObjects = extractJsonLdObjects($);
  for (const entry of jsonLdObjects) {
    const candidates = [];
    if (entry && typeof entry === 'object') candidates.push(entry);
    if (entry && typeof entry === 'object' && Array.isArray(entry['@graph'])) {
      candidates.push(...entry['@graph']);
    }
    for (const candidate of candidates) {
      const price = candidate?.offers?.price;
      if (price == null) continue;
      const image = Array.isArray(candidate?.image)
        ? candidate.image[0]
        : candidate?.image || candidate?.offers?.image || '';
      const title = candidate?.name || candidate?.headline || candidate?.description || '';
      return {
        title: cleanTitle(title),
        price: Number(price),
        priceText: normalizePriceText(price),
        imageUrl: image || '',
        sourceUrl: pageUrl
      };
    }
  }
  return null;
}

async function resolvePublicReviewData(title) {
  const rawTitle = cleanTitle(title || '').trim();
  const normalizedTitle = normalizeText(title || '').replace(/\s+/g, ' ').trim();
  const queries = [
    `${rawTitle} review completo`,
    `${normalizedTitle} review completo`,
    rawTitle,
    normalizedTitle
  ].filter((query, index, list) => query && list.indexOf(query) === index);

  let candidates = [];

  for (const query of queries) {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchResponse = await axios.get(searchUrl, {
      timeout: 20000,
      headers: {
        'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
      }
    });

    const $ = cheerio.load(searchResponse.data);
    const found = [];

    $('.result').each((_, element) => {
      const link = decodeDuckDuckGoUrl($(element).find('.result__title a').attr('href') || '');
      const resultTitle = $(element).find('.result__title').text().replace(/\s+/g, ' ').trim();
      const snippet = $(element).find('.result__snippet').text().replace(/\s+/g, ' ').trim();
      if (!link) return;
      if (!/ofertaninja\.com\.br|ofertasdachloe\.com\.br/i.test(link)) return;
      found.push({ link, resultTitle, snippet });
    });

    if (found.length) {
      candidates = found;
      break;
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aPriority = /ofertaninja\.com\.br/i.test(a.link) ? 0 : 1;
    const bPriority = /ofertaninja\.com\.br/i.test(b.link) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return b.resultTitle.length - a.resultTitle.length;
  });

  const pageUrl = candidates[0].link;
  const pageResponse = await axios.get(pageUrl, {
    timeout: 25000,
    headers: {
      'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
    }
  });

  const rawHtml = String(pageResponse.data);
  const page = cheerio.load(rawHtml);
  const fromJsonLd = extractOfferFromJsonLd(page, pageUrl);
  const ogImage = page('meta[property="og:image"]').attr('content') || '';
  const ogTitle = page('meta[property="og:title"]').attr('content') || '';
  const priceMatch =
    rawHtml.match(/"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i) ||
    rawHtml.match(/"price"\s*:\s*"([0-9]+(?:\.[0-9]+)?)"/i);
  const resolvedPrice = fromJsonLd?.price ?? (priceMatch ? Number(priceMatch[1]) : null);
  const resolvedPriceText = fromJsonLd?.priceText || normalizePriceText(resolvedPrice);

  if (!resolvedPrice && !ogImage && !ogTitle) return null;

  return {
    title: cleanTitle(fromJsonLd?.title || ogTitle || candidates[0].resultTitle || title),
    price: resolvedPrice,
    priceText: resolvedPriceText,
    imageUrl: fromJsonLd?.imageUrl || ogImage || '',
    sourceUrl: pageUrl
  };
}

async function enrichOfferFromUrl(url, context = '') {
  const contextText = typeof context === 'string' ? context : context?.text || '';
  const contextImageUrl = typeof context === 'object' ? context?.imageUrl || '' : '';
  const contextPriceText = typeof context === 'object' ? context?.priceText || '' : '';
  const canonicalUrl = canonicalizeUrl(url);
  const base = {
    url: canonicalUrl,
    source: 'public_sources',
    collectedAt: new Date().toISOString()
  };

  try {
    const preview = await getLinkPreview(canonicalUrl, {
      timeout: 12000,
      followRedirects: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
      }
    });

    const fallbackTitle = titleFromSlug(canonicalUrl) || contextText || 'Oferta Shopee';
    const title = cleanTitle(preview.title || fallbackTitle);
    const rawDescription = preview.description || contextText || '';
    const description = cleanTitle(rawDescription);
    const normalizedTitle = normalizeText(title);
    const normalizedDescription = normalizeText(description);
    const finalDescription = normalizedDescription && normalizedDescription !== normalizedTitle
      ? description.slice(0, 220)
      : '';
    const imageUrl = contextImageUrl || (Array.isArray(preview.images) ? preview.images[0] : null);
    const reliableImageUrl = isShopeeUrl(canonicalUrl) ? contextImageUrl || '' : imageUrl;
    const price = contextPriceText ? parseLastPrice(contextPriceText) : parsePrice(`${title} ${finalDescription} ${contextText}`);
    const textForFilter = `${title} ${finalDescription} ${contextText} ${contextPriceText}`;

    if (!passesKeywordFilter(textForFilter) || !passesPriceFilter(price)) return null;

    let verifiedImage = null;
    if (isShopeeUrl(canonicalUrl)) {
      const resolvedShopee = await resolveShopeeProductDetails(canonicalUrl);
      if (resolvedShopee?.imageUrl) {
        const page = cheerio.load(resolvedShopee.rawHtml || '');
        const pageImage = await resolveVerifiedPageImage(page, canonicalUrl, title);
        verifiedImage = pageImage.imageVerified ? pageImage : {
          imageUrl: resolvedShopee.imageUrl,
          imageSource: 'shopee_meta',
          imageConfidence: 60,
          imageVerified: false
        };
      }
    }
    if (!verifiedImage?.imageUrl && config.googleImageSearchApiKey && config.googleImageSearchCx) {
      const googleImage = await resolveGoogleProductImage({
        title: isGenericTitle(title) ? fallbackTitle : title,
        description: finalDescription,
        contextText
      });
      if (googleImage?.imageUrl) {
        verifiedImage = {
          imageUrl: googleImage.imageUrl,
          imageSource: 'google_image',
          imageConfidence: googleImage.score,
          imageVerified: true
        };
      }
    }
    return {
      ...base,
      title: isGenericTitle(title) ? cleanTitle(fallbackTitle) : title,
      description: finalDescription,
      price,
      priceText: contextPriceText || (price ? `R$ ${price.toFixed(2).replace('.', ',')}` : null),
      imageUrl: verifiedImage?.imageUrl || reliableImageUrl,
      imageVerified: Boolean(verifiedImage?.imageVerified),
      imageSource: verifiedImage?.imageSource || '',
      imageConfidence: verifiedImage?.imageConfidence || 0,
      rawText: contextText
    };
  } catch (error) {
    const fallbackTitle = titleFromSlug(canonicalUrl) || contextText || 'Oferta Shopee';
    const title = cleanTitle(contextText || fallbackTitle || 'Oferta Shopee');
    const price = contextPriceText ? parseLastPrice(contextPriceText) : parsePrice(`${contextText}`);
    if (!config.allowLinkOnly) return null;
    if (!passesKeywordFilter(contextText || canonicalUrl) || !passesPriceFilter(price)) return null;

    let verifiedImage = null;
    if (isShopeeUrl(canonicalUrl)) {
      const resolvedShopee = await resolveShopeeProductDetails(canonicalUrl);
      if (resolvedShopee?.imageUrl) {
        verifiedImage = {
          imageUrl: resolvedShopee.imageUrl,
          imageSource: resolvedShopee.imageSource || 'shopee_page',
          imageConfidence: resolvedShopee.imageConfidence || 0,
          imageVerified: Boolean(resolvedShopee.imageVerified)
        };
      }
    }
    if (config.googleImageSearchApiKey && config.googleImageSearchCx) {
      const googleImage = await resolveGoogleProductImage({
        title,
        description: '',
        contextText
      });
      if (googleImage?.imageUrl) {
        verifiedImage = {
          imageUrl: googleImage.imageUrl,
          imageSource: 'google_image',
          imageConfidence: googleImage.score,
          imageVerified: true
        };
      }
    }
    return {
      ...base,
      title: isGenericTitle(title) ? cleanTitle(fallbackTitle) : title,
      description: '',
      price,
      priceText: contextPriceText || (price ? `R$ ${price.toFixed(2).replace('.', ',')}` : null),
      imageUrl: verifiedImage?.imageUrl || (isShopeeUrl(canonicalUrl) ? contextImageUrl || null : contextImageUrl || null),
      imageVerified: Boolean(verifiedImage?.imageVerified),
      imageSource: verifiedImage?.imageSource || '',
      imageConfidence: verifiedImage?.imageConfidence || 0,
      rawText: contextText,
      previewError: error.message
    };
  }
}

async function fetchShopeeProductImage(url) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
      }
    });
    const $ = cheerio.load(response.data);
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[property="twitter:image"]').attr('content') ||
      '';
    return image || '';
  } catch {
    return '';
  }
}

async function resolveShopeeProductDetails(url) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
      },
      validateStatus: (status) => status >= 200 && status < 500
    });

    const finalUrl = response.request?.res?.responseUrl || canonicalizeUrl(url);
    const rawHtml = String(response.data || '');
    const page = cheerio.load(rawHtml);
    const fromJsonLd = extractOfferFromJsonLd(page, finalUrl);
    const ogTitle = page('meta[property="og:title"]').attr('content') || '';
    const twitterTitle = page('meta[name="twitter:title"]').attr('content') || '';
    const ogImage = page('meta[property="og:image"]').attr('content') || '';
    const twitterImage = page('meta[name="twitter:image"]').attr('content') || '';
    const description = page('meta[property="og:description"]').attr('content') || page('meta[name="description"]').attr('content') || '';
    const priceMatch =
      rawHtml.match(/"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i) ||
      rawHtml.match(/"price"\s*:\s*"([0-9]+(?:\.[0-9]+)?)"/i);
    const resolvedPrice = fromJsonLd?.price ?? (priceMatch ? Number(priceMatch[1]) : null);
    const verifiedImage = await resolveVerifiedPageImage(page, finalUrl, cleanTitle(fromJsonLd?.title || ogTitle || twitterTitle || titleFromSlug(finalUrl) || ''));

    return {
      url: finalUrl,
      title: cleanTitle(fromJsonLd?.title || ogTitle || twitterTitle || titleFromSlug(finalUrl) || ''),
      imageUrl: verifiedImage.imageUrl || fromJsonLd?.imageUrl || ogImage || twitterImage || '',
      imageVerified: verifiedImage.imageVerified,
      imageSource: verifiedImage.imageSource,
      imageConfidence: verifiedImage.imageConfidence,
      description: cleanTitle(description || ''),
      price: resolvedPrice,
      priceText: fromJsonLd?.priceText || (resolvedPrice ? normalizePriceText(resolvedPrice) : ''),
      rawHtml
    };
  } catch {
    return null;
  }
}

module.exports = { isShopeeUrl, canonicalizeUrl, passesKeywordFilter, enrichOfferFromUrl, fetchShopeeProductImage, resolveShopeeProductDetails, parseLastPrice, resolvePublicReviewData, resolveGoogleProductImage };
