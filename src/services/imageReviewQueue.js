const axios = require('axios');
const { imageSize } = require('image-size');
const config = require('../config');
const {
  getReviewOffers,
  markReadyToPublish,
  markImageReviewFailed,
  queueStats
} = require('../queue/offerQueue');
const { enrichAndValidateOffer } = require('./productQualityGate');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  'Chrome/120.0.0.0 Safari/537.36';

function cleanValidatedOffer(offer = {}) {
  const clean = { ...offer };
  delete clean.imageBuffer;
  delete clean.imageContentType;
  return clean;
}

function hasPublishablePrice(offer = {}) {
  return offer.price != null || Boolean(offer.priceText);
}

function looksLikeCategoryTitle(title = '') {
  const text = String(title || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return [
    'games e geek',
    'supermercado',
    'esporte e lazer',
    'infantil e brinquedos',
    'moda e acessorios',
    'beleza e cuidados pessoais',
    'casa moveis e decoracao'
  ].includes(text);
}

async function validateCollectedCardImage(imageUrl) {
  if (!imageUrl) return { ok: false, reason: 'missing_card_image' };

  try {
    const response = await axios.get(imageUrl, {
      timeout: 15000,
      responseType: 'arraybuffer',
      maxContentLength: 8 * 1024 * 1024,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      validateStatus: (status) => status >= 200 && status < 300
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const buffer = Buffer.from(response.data || []);
    const bytes = buffer.byteLength;

    if (!contentType.startsWith('image/')) return { ok: false, reason: 'not_image', contentType, bytes };
    if (bytes < (config.imageMinBytes || 10000)) return { ok: false, reason: 'image_too_small_bytes', contentType, bytes };

    let dimensions = null;
    try {
      dimensions = imageSize(buffer);
    } catch {
      dimensions = null;
    }

    const width = dimensions?.width || 0;
    const height = dimensions?.height || 0;
    if (width && width < (config.imageMinWidth || 180)) return { ok: false, reason: 'image_too_narrow', contentType, bytes, width, height };
    if (height && height < (config.imageMinHeight || 180)) return { ok: false, reason: 'image_too_short', contentType, bytes, width, height };

    const normalizedUrl = String(imageUrl).toLowerCase();
    if (/logo|banner|placeholder|sprite|avatar|category|categoria|default|loading|transparent|pixel|blank|no-image|sem-imagem/.test(normalizedUrl)) {
      return { ok: false, reason: 'generic_card_image', contentType, bytes, width, height };
    }

    return { ok: true, contentType, bytes, width, height };
  } catch (error) {
    return { ok: false, reason: 'card_image_download_failed', error: error.message };
  }
}

async function buildCardImageFallback(offer = {}, result = null) {
  const imageUrl = String(offer.imageUrl || offer.image || '').trim();
  const title = String(result?.title || offer.title || '').trim();

  if (!imageUrl) return null;
  if (!title || looksLikeCategoryTitle(title)) return null;
  if (!hasPublishablePrice(offer)) return null;

  const validation = await validateCollectedCardImage(imageUrl);
  if (!validation.ok) return null;

  return {
    ...offer,
    title,
    imageUrl,
    imageVerified: true,
    imageSource: 'category_card_image',
    imageConfidence: validation.width >= 300 && validation.height >= 300 ? 72 : 68,
    imageContentType: validation.contentType || 'image/jpeg',
    quality: {
      ...(offer.quality || {}),
      imageSource: 'category_card_image',
      imageConfidence: validation.width >= 300 && validation.height >= 300 ? 72 : 68,
      imageValidation: validation,
      imageFallbackReason: result?.reason || 'product_page_no_trusted_image'
    },
    verified: {
      product: true,
      image: true,
      source: 'category_card_fallback'
    }
  };
}

async function reviewPendingOfferImages(limit = config.imageReviewBatchSize, sourceUrl = null) {
  const candidates = getReviewOffers(limit, sourceUrl, config.imageReviewMaxAttempts);
  const summary = {
    candidates: candidates.length,
    reviewed: 0,
    ready: 0,
    failed: 0,
    stats: queueStats()
  };

  for (const offer of candidates) {
    summary.reviewed += 1;

    try {
      const result = await enrichAndValidateOffer(offer);

      if (result?.ok && result.offer) {
        markReadyToPublish(offer, cleanValidatedOffer(result.offer));
        summary.ready += 1;
        console.log(`[ImageReview] Oferta pronta para publicar: ${result.offer.title || offer.title}`);
        continue;
      }

      const fallbackOffer = await buildCardImageFallback(offer, result);
      if (fallbackOffer) {
        markReadyToPublish(offer, cleanValidatedOffer(fallbackOffer));
        summary.ready += 1;
        console.log(`[ImageReview] Oferta pronta com imagem do card: ${fallbackOffer.title || offer.title}`);
        continue;
      }

      markImageReviewFailed(offer, result || { reason: 'validation_failed' });
      summary.failed += 1;
      console.log(`[ImageReview] Oferta mantida para nova revisão: ${offer.title} (${result?.reason || 'validation_failed'})`);
    } catch (error) {
      const fallbackOffer = await buildCardImageFallback(offer, { reason: 'image_review_error', error: error.message });
      if (fallbackOffer) {
        markReadyToPublish(offer, cleanValidatedOffer(fallbackOffer));
        summary.ready += 1;
        console.log(`[ImageReview] Oferta pronta com imagem do card após erro: ${fallbackOffer.title || offer.title}`);
        continue;
      }

      markImageReviewFailed(offer, { reason: 'image_review_error', error: error.message });
      summary.failed += 1;
      console.log(`[ImageReview] Erro ao revisar oferta: ${offer.title} (${error.message})`);
    }
  }

  summary.stats = queueStats();
  return summary;
}

module.exports = { reviewPendingOfferImages };
