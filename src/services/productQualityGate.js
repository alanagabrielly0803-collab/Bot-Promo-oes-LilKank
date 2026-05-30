const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { imageSize } = require('image-size');
const config = require('../config');
const { cleanTitle, normalizeText, isGenericTitle, titleFromSlug } = require('../utils/text');
const { canonicalizeUrl, isShopeeUrl, parseLastPrice } = require('../sources/offerExtractor');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  'Chrome/120.0.0.0 Safari/537.36';

const BAD_IMAGE_PATTERNS = [
  'logo',
  'banner',
  'placeholder',
  'sprite',
  'icon',
  'avatar',
  'category',
  'categoria',
  'default',
  'loading',
  'transparent',
  'pixel',
  'blank',
  'no-image',
  'sem-imagem',
  '1c8bdaaf45e1fd48.png',
  'shopee-pcmall-live-sg/assets/1c8bdaaf45e1fd48.png',
  'shopee-mobilemall-live-sg/assets/1c8bdaaf45e1fd48.png'
];

const BAD_TITLE_PATTERNS = [
  /^ver oferta$/i,
  /^oferta$/i,
  /^comprar$/i,
  /^produto$/i,
  /^promoção$/i,
  /^promocao$/i,
  /^clique aqui$/i,
  /^\d+$/,
  /^[a-z0-9]{6,}$/i
];

function reject(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function parsePriceValue(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const text = cleanText(value);
  if (!text) return null;

  const parsedCurrency = parseLastPrice(text);
  if (parsedCurrency != null) return parsedCurrency;

  const compact = text.replace(/[^\d.,]/g, '');
  if (!compact) return null;

  if (compact.includes(',') && compact.includes('.')) {
    const lastComma = compact.lastIndexOf(',');
    const lastDot = compact.lastIndexOf('.');
    if (lastComma > lastDot) {
      const normalized = compact.replace(/\./g, '').replace(',', '.');
      const valueNumber = Number(normalized);
      return Number.isFinite(valueNumber) ? valueNumber : null;
    }
    const normalized = compact.replace(/,/g, '');
    const valueNumber = Number(normalized);
    return Number.isFinite(valueNumber) ? valueNumber : null;
  }

  const normalized = compact.replace(',', '.');
  const valueNumber = Number(normalized);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function formatPriceValue(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return `R$ ${Number(value).toFixed(2).replace('.', ',')}`;
}

function shouldUseCardScreenshot(rawCandidate) {
  const text = cleanText([
    rawCandidate?.cardText,
    rawCandidate?.rawText,
    rawCandidate?.title,
    rawCandidate?.description
  ].join(' '));

  return /cupom|frete|desconto|inaplic|promoç|promocao/i.test(text) &&
    Boolean(rawCandidate?.sourceUrl) &&
    Boolean(rawCandidate?.url);
}

function isBadTitle(title) {
  const text = cleanText(title);
  if (!text) return true;
  if (text.length < 8) return true;
  if (text.length > 220) return true;
  return BAD_TITLE_PATTERNS.some((re) => re.test(text));
}

function absoluteUrl(url, baseUrl) {
  if (!url) return null;
  try {
    return new URL(String(url).trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function fetchHtml(url) {
  return axios.get(url, {
    timeout: 18000,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    validateStatus: (status) => status >= 200 && status < 400
  });
}

function getFinalAxiosUrl(response, fallbackUrl) {
  return response?.request?.res?.responseUrl || response?.request?._currentUrl || fallbackUrl;
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
    return out;
  }
  if (typeof node === 'object') {
    out.push(node);
    if (Array.isArray(node['@graph'])) {
      for (const item of node['@graph']) flattenJsonLd(item, out);
    }
  }
  return out;
}

function isProductNode(node) {
  const type = node?.['@type'];
  if (type === 'Product') return true;
  if (Array.isArray(type) && type.includes('Product')) return true;
  return false;
}

function normalizeImageValue(value, baseUrl) {
  if (!value) return [];

  if (typeof value === 'string') {
    const parts = value.includes(',') ? value.split(',') : [value];
    const urls = [];
    for (const part of parts) {
      const raw = part.trim().split(/\s+/)[0];
      const abs = absoluteUrl(raw, baseUrl);
      if (abs) urls.push(abs);
    }
    return urls;
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeImageValue(item, baseUrl));
  }

  if (typeof value === 'object') {
    const possible = value.url || value.contentUrl || value.thumbnailUrl || value['@id'] || value.image;
    const abs = absoluteUrl(possible, baseUrl);
    return abs ? [abs] : [];
  }

  return [];
}

function extractJsonLdProducts($) {
  const products = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = cleanText($(el).contents().text());
    if (!raw) return;
    const parsed = safeParseJson(raw);
    if (!parsed) return;
    const nodes = flattenJsonLd(parsed);
    for (const node of nodes) {
      if (isProductNode(node)) products.push(node);
    }
  });
  return products;
}

function firstNonBadTitle(...titles) {
  for (const title of titles) {
    const text = cleanText(title);
    if (text && !isBadTitle(text)) return text;
  }
  return '';
}

function extractTitle($, products, rawCandidate) {
  const jsonLdTitle = firstNonBadTitle(...products.map((p) => p?.name));
  if (jsonLdTitle) return { title: jsonLdTitle, source: 'jsonld_product', confidence: 95 };

  const ogTitle = firstNonBadTitle($('meta[property="og:title"]').first().attr('content'));
  if (ogTitle) return { title: ogTitle, source: 'og_title', confidence: 85 };

  const twitterTitle = firstNonBadTitle($('meta[name="twitter:title"]').first().attr('content'));
  if (twitterTitle) return { title: twitterTitle, source: 'twitter_title', confidence: 80 };

  const htmlTitle = firstNonBadTitle($('title').first().text());
  if (htmlTitle) return { title: htmlTitle, source: 'html_title', confidence: 70 };

  const cardTitle = firstNonBadTitle(rawCandidate?.cardTitle, rawCandidate?.title, rawCandidate?.text, titleFromSlug(rawCandidate?.url));
  if (cardTitle) return { title: cardTitle, source: 'category_card', confidence: 55 };

  return { title: '', source: 'none', confidence: 0 };
}

function extractPriceFromJsonLd(products) {
  for (const product of products) {
    const offers = Array.isArray(product.offers) ? product.offers : product.offers ? [product.offers] : [];
    for (const offer of offers) {
      const price = cleanText(offer?.price || offer?.lowPrice || offer?.highPrice);
      if (price) return price;
    }
  }
  return '';
}

function extractPrice($, products, rawCandidate) {
  const jsonLdPrice = cleanText(extractPriceFromJsonLd(products));
  if (jsonLdPrice) {
    const parsed = parsePriceValue(jsonLdPrice);
    if (parsed != null) return { price: parsed, source: 'jsonld_product', confidence: 95 };
  }

  const metaPrice = cleanText(
    $('meta[property="product:price:amount"]').first().attr('content') ||
    $('meta[property="og:price:amount"]').first().attr('content') ||
    $('meta[name="product:price:amount"]').first().attr('content')
  );
  if (metaPrice) {
    const parsed = parsePriceValue(metaPrice);
    if (parsed != null) return { price: parsed, source: 'meta_price', confidence: 80 };
  }

  const rawPriceText = cleanText(rawCandidate?.priceText || rawCandidate?.price || '');
  if (rawPriceText) {
    const parsed = parsePriceValue(rawPriceText);
    if (parsed != null) return { price: parsed, source: 'category_card', confidence: 55 };
  }

  return { price: '', source: 'none', confidence: 0 };
}

function pickBestFromSrcset(srcset, baseUrl) {
  if (!srcset) return '';
  const candidates = String(srcset)
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      const [url, size] = part.split(/\s+/);
      const width = size?.endsWith('w') ? Number(size.replace('w', '')) : 0;
      return { url: absoluteUrl(url, baseUrl), width };
    })
    .filter((item) => item.url);
  candidates.sort((a, b) => b.width - a.width);
  return candidates[0]?.url || '';
}

function scoreImageCandidate(candidate, title) {
  let score = candidate.baseConfidence || 0;
  const urlLower = String(candidate.url || '').toLowerCase();
  const altLower = cleanText(candidate.alt || '').toLowerCase();
  const dimensions = `${candidate.widthHint || 0}x${candidate.heightHint || 0}`;
  const titleTokens = cleanText(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/gi, ''))
    .filter((t) => t.length >= 4);

  for (const bad of BAD_IMAGE_PATTERNS) {
    if (urlLower.includes(bad)) score -= 40;
    if (altLower.includes(bad)) score -= 20;
  }

  if (/^470x240$/.test(dimensions) && /shopee|susercontent|deo\.shopeemobile/i.test(urlLower)) {
    score -= 50;
  }
  if (/world map|mapa|shopee/i.test(altLower) && /shopee|susercontent|deo\.shopeemobile/i.test(urlLower)) {
    score -= 60;
  }

  for (const token of titleTokens) {
    if (altLower.includes(token)) score += 6;
    if (urlLower.includes(token)) score += 3;
  }

  if (candidate.widthHint >= 300) score += 5;
  if (candidate.heightHint >= 300) score += 5;
  if (candidate.widthHint >= 600) score += 5;
  if (candidate.heightHint >= 600) score += 5;
  if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(candidate.url)) score += 5;
  if (/\/(logo|banner|category|static)\//i.test(candidate.url)) score -= 35;

  return Math.max(0, Math.min(100, score));
}

function extractImageCandidatesFromHtml($, pageUrl, products) {
  const candidates = [];

  for (const product of products) {
    for (const url of normalizeImageValue(product.image, pageUrl)) {
      candidates.push({ url, source: 'jsonld_product', baseConfidence: 95 });
    }
  }

  const metas = [
    { selector: 'meta[property="og:image"]', source: 'og_image', score: 88 },
    { selector: 'meta[property="og:image:secure_url"]', source: 'og_image_secure_url', score: 90 },
    { selector: 'meta[name="twitter:image"]', source: 'twitter_image', score: 80 },
    { selector: 'meta[name="twitter:image:src"]', source: 'twitter_image_src', score: 80 }
  ];

  for (const meta of metas) {
    const content = cleanText($(meta.selector).first().attr('content'));
    const url = absoluteUrl(content, pageUrl);
    if (url) {
      candidates.push({ url, source: meta.source, baseConfidence: meta.score });
    }
  }

  $('img').each((_, img) => {
    const el = $(img);
    const srcset =
      el.attr('srcset') ||
      el.attr('data-srcset') ||
      el.attr('data-lazy-srcset') ||
      '';
    const srcsetUrl = pickBestFromSrcset(srcset, pageUrl);
    const rawUrl =
      srcsetUrl ||
      el.attr('data-zoom-image') ||
      el.attr('data-large-image') ||
      el.attr('data-original') ||
      el.attr('data-lazy-src') ||
      el.attr('data-src') ||
      el.attr('src') ||
      '';
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return;
    candidates.push({
      url,
      source: srcsetUrl ? 'dom_srcset' : 'dom_img',
      alt: `${el.attr('alt') || ''} ${el.attr('title') || ''}`,
      widthHint: Number(el.attr('width') || 0),
      heightHint: Number(el.attr('height') || 0),
      baseConfidence: srcsetUrl ? 68 : 58
    });
  });

  return candidates;
}

async function validateImageUrl(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      timeout: 12000,
      responseType: 'arraybuffer',
      maxContentLength: 8 * 1024 * 1024,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      validateStatus: (status) => status >= 200 && status < 300
    });

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const buffer = Buffer.from(response.data);
    const bytes = buffer.byteLength;

    if (!contentType.startsWith('image/')) return { ok: false, reason: 'not_image', contentType, bytes };
    if (bytes < (config.imageMinBytes || 10000)) return { ok: false, reason: 'image_too_small_bytes', contentType, bytes };

    let dimensions = null;
    try {
      dimensions = imageSize(buffer);
    } catch {
      dimensions = null;
    }

    if (dimensions?.width && dimensions?.height) {
      if (dimensions.width < (config.imageMinWidth || 180) || dimensions.height < (config.imageMinHeight || 180)) {
        return {
          ok: false,
          reason: 'image_too_small_dimensions',
          contentType,
          bytes,
          width: dimensions.width,
          height: dimensions.height
        };
      }
    }

    return {
      ok: true,
      contentType,
      bytes,
      width: dimensions?.width || 0,
      height: dimensions?.height || 0
    };
  } catch (error) {
    return { ok: false, reason: 'image_download_failed', error: error.message };
  }
}

async function chooseBestImage(candidates, title, allowPlaywright = true) {
  const scored = candidates
    .map((candidate) => ({ ...candidate, confidence: scoreImageCandidate(candidate, title) }))
    .filter((candidate) => candidate.confidence >= 45)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);

  for (const candidate of scored) {
    const validation = await validateImageUrl(candidate.url);
    if (!validation.ok) {
      candidate.validation = validation;
      continue;
    }
    let confidence = candidate.confidence;
    if (validation.width >= 300 && validation.height >= 300) confidence += 5;
    if (validation.width >= 600 && validation.height >= 600) confidence += 5;
    confidence = Math.max(0, Math.min(100, confidence));
    if (confidence >= (config.imageMinConfidence || 70)) {
      return {
        ok: true,
        image: candidate.url,
        source: candidate.source,
        confidence,
        validation
      };
    }
  }

  if (!allowPlaywright || config.playwrightImageFallback === false) {
    return {
      ok: false,
      reason: 'no_confident_image',
      checked: scored.map((item) => ({
        url: item.url,
        source: item.source,
        confidence: item.confidence,
        validation: item.validation || null
      }))
    };
  }

  return {
    ok: false,
    reason: 'needs_playwright'
  };
}

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((error) => {
      browserPromise = null;
      console.warn('[QualityGate] Playwright indisponível neste ambiente:', error.message);
      return null;
    });
  }
  return browserPromise;
}

async function extractWithPlaywright(url, title) {
  const browser = await getBrowser();
  if (!browser) {
    return {
      ok: false,
      reason: 'playwright_unavailable'
    };
  }
  const pageUrl = url;
  const page = await browser.newPage({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 }
  });

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwrightTimeoutMs || 18000
    });

    await page.waitForTimeout(2500);

    let rendered;
    try {
      rendered = await page.evaluate(() => {
        const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
        const images = Array.from(document.querySelectorAll('img')).map((img) => ({
          url:
            img.currentSrc ||
            img.src ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy-src') ||
            '',
          srcset:
            img.getAttribute('srcset') ||
            img.getAttribute('data-srcset') ||
            img.getAttribute('data-lazy-srcset') ||
            '',
          alt: `${img.getAttribute('alt') || ''} ${img.getAttribute('title') || ''}`,
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0
        }));

        return {
          title:
            meta('meta[property="og:title"]') ||
            meta('meta[name="twitter:title"]') ||
            document.title ||
            '',
          images,
          metas: [
            { url: meta('meta[property="og:image"]'), source: 'playwright_og_image' },
            { url: meta('meta[property="og:image:secure_url"]'), source: 'playwright_og_image_secure_url' },
            { url: meta('meta[name="twitter:image"]'), source: 'playwright_twitter_image' },
            { url: meta('meta[name="twitter:image:src"]'), source: 'playwright_twitter_image_src' }
          ]
        };
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'playwright_evaluate_failed',
        error: error.message
      };
    }

    const candidates = [];

    for (const meta of rendered.metas || []) {
      const imageUrl = absoluteUrl(meta.url, pageUrl);
      if (imageUrl) {
        candidates.push({ url: imageUrl, source: meta.source, baseConfidence: 82 });
      }
    }

    for (const img of rendered.images || []) {
      const srcsetUrl = pickBestFromSrcset(img.srcset, pageUrl);
      const imageUrl = absoluteUrl(srcsetUrl || img.url, pageUrl);
      if (!imageUrl) continue;
      candidates.push({
        url: imageUrl,
        source: srcsetUrl ? 'playwright_srcset' : 'playwright_dom_img',
        alt: img.alt,
        widthHint: img.width,
        heightHint: img.height,
        baseConfidence: srcsetUrl ? 75 : 70
      });
    }

    const best = await chooseBestImage(candidates, title || rendered.title, false);
    return {
      ...best,
      renderedTitle: cleanText(rendered.title)
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractCardScreenshot(rawCandidate) {
  if (!shouldUseCardScreenshot(rawCandidate)) return null;

  const sourceUrl = rawCandidate?.sourceUrl;
  const productUrl = rawCandidate?.cardUrl || rawCandidate?.url || rawCandidate?.resolvedUrl;
  if (!sourceUrl || !productUrl) return null;

  const browser = await getBrowser();
  if (!browser) {
    return null;
  }
  const page = await browser.newPage({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 1600 }
  });

  try {
    await page.goto(sourceUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwrightTimeoutMs || 18000
    });
    await page.waitForTimeout(1800);

    const productPath = (() => {
      try {
        return new URL(productUrl).pathname.split('/').filter(Boolean).pop() || '';
      } catch {
        return '';
      }
    })();

    if (!productPath) return null;

    const anchor = page.locator(`a[href*="${productPath}"]`).first();
    const anchorCount = await anchor.count().catch(() => 0);
    if (!anchorCount) return null;

    const cardHandle = await anchor.evaluateHandle((el) => {
      return (
        el.closest('div.group') ||
        el.closest('article') ||
        el.closest('li') ||
        el.closest('section') ||
        el.closest('div') ||
        el
      );
    });
    const card = cardHandle.asElement();
    if (!card) return null;

    await card.scrollIntoViewIfNeeded().catch(() => {});
    const shot = await card.screenshot({ type: 'png' });
    return {
      image: shot,
      source: 'card_screenshot',
      confidence: 90,
      validation: {
        ok: true,
        contentType: 'image/png',
        bytes: shot.byteLength,
        width: 0,
        height: 0
      }
    };
  } catch (error) {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function enrichAndValidateOffer(rawCandidate) {
  if (!rawCandidate?.url) {
    return reject('missing_url', { rawCandidate });
  }

  let response;
  try {
    response = await fetchHtml(rawCandidate.url);
  } catch (error) {
    return reject('html_fetch_failed', { error: error.message, rawCandidate });
  }

  const html = String(response.data || '');
  const finalUrl = getFinalAxiosUrl(response, rawCandidate.url);
  const $ = cheerio.load(html);
  const products = extractJsonLdProducts($);

  const titleResult = extractTitle($, products, rawCandidate);
  const priceResult = extractPrice($, products, rawCandidate);

  const baseTitle = cleanText(rawCandidate?.title || rawCandidate?.cardTitle || titleFromSlug(rawCandidate?.url) || '');
  const title = cleanText(titleResult.title || baseTitle);

  if (!title || isBadTitle(title)) {
    return reject('bad_or_missing_title', { titleResult, rawCandidate, finalUrl });
  }

  const imageCandidates = extractImageCandidatesFromHtml($, finalUrl, products);
  let imageResult = await chooseBestImage(imageCandidates, title, true);

  if (!imageResult.ok && imageResult.reason === 'needs_playwright') {
    imageResult = await extractWithPlaywright(finalUrl, title);
  }

  const primaryPriceValue = parsePriceValue(priceResult.price);
  const fallbackPriceValue = parsePriceValue(rawCandidate?.priceText || rawCandidate?.price);
  const finalPriceValue = primaryPriceValue ?? fallbackPriceValue;

  if (finalPriceValue == null) {
    return reject('missing_price', { title, pageUrl: finalUrl });
  }

  if (!imageResult.ok) {
    if (config.allowUntrustedImageTesting) {
      const fallbackImageUrl =
        cleanText(rawCandidate?.imageUrl || rawCandidate?.image || imageResult.checked?.[0]?.url || '');

      if (!fallbackImageUrl) {
        return reject('no_trusted_image', { title, pageUrl: finalUrl, imageResult });
      }

      const fallbackImageSource = imageResult.reason === 'needs_playwright'
        ? 'untrusted_playwright_fallback'
        : 'untrusted_fallback';

      const priceText = formatPriceValue(finalPriceValue);
      return {
        ok: true,
        offer: {
          ...rawCandidate,
          url: canonicalizeUrl(finalUrl),
          title,
          price: finalPriceValue,
          priceText,
          imageUrl: fallbackImageUrl,
          imageContentType: imageResult.validation?.contentType || 'image/jpeg',
          imageVerified: false,
          imageSource: fallbackImageSource,
          imageConfidence: 0,
          quality: {
            titleSource: titleResult.source,
            titleConfidence: titleResult.confidence,
            priceSource: priceResult.source,
            priceConfidence: priceResult.confidence,
            imageSource: fallbackImageSource,
            imageConfidence: 0,
            imageValidation: imageResult.validation || null
          },
          verified: {
            product: true,
            image: false,
            source: 'product_page'
          }
        }
      };
    }
    return reject('no_trusted_image', { title, pageUrl: finalUrl, imageResult });
  }

  const rawPriceSource = String(rawCandidate?.priceSource || '');
  if (priceResult.source === 'category_card') {
    if (!['card', 'card_fallback'].includes(rawPriceSource)) {
      return reject('ambiguous_category_price', { title, pageUrl: finalUrl, priceResult, rawPriceSource });
    }
    if (priceResult.confidence < 45) {
      return reject('low_confidence_category_price', { title, pageUrl: finalUrl, priceResult, rawPriceSource });
    }
  }

  const priceText = formatPriceValue(finalPriceValue);
  let screenshotResult = null;
  if (config.playwrightImageFallback !== false && shouldUseCardScreenshot(rawCandidate)) {
    screenshotResult = await extractCardScreenshot({
      ...rawCandidate,
      cardUrl: rawCandidate.url,
      resolvedUrl: finalUrl,
      title
    });
  }

  const finalImageUrl = imageResult.image;
  const finalImageSource = screenshotResult?.source || imageResult.source;
  const finalImageConfidence = screenshotResult?.confidence || imageResult.confidence;
  const finalImageValidation = screenshotResult?.validation || imageResult.validation || null;

  return {
    ok: true,
    offer: {
      ...rawCandidate,
      url: canonicalizeUrl(finalUrl),
      title,
      price: finalPriceValue,
      priceText,
      imageUrl: finalImageUrl,
      imageBuffer: screenshotResult?.image || null,
      imageContentType: finalImageValidation?.contentType || 'image/jpeg',
      imageVerified: true,
      imageSource: finalImageSource,
      imageConfidence: finalImageConfidence,
      quality: {
        titleSource: titleResult.source,
        titleConfidence: titleResult.confidence,
        priceSource: priceResult.source,
        priceConfidence: priceResult.confidence,
        imageSource: finalImageSource,
        imageConfidence: finalImageConfidence,
        imageValidation: finalImageValidation
      },
      verified: {
        product: true,
        image: true,
        source: 'product_page'
      }
    }
  };
}

async function closePlaywrightBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = {
  enrichAndValidateOffer,
  closePlaywrightBrowser
};
