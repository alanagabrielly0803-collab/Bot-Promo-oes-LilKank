const config = require('../config');
const {
  getReviewOffers,
  markReadyToPublish,
  markImageReviewFailed,
  queueStats
} = require('../queue/offerQueue');
const { enrichAndValidateOffer } = require('./productQualityGate');

function cleanValidatedOffer(offer = {}) {
  const clean = { ...offer };
  delete clean.imageBuffer;
  delete clean.imageContentType;
  return clean;
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
      } else {
        markImageReviewFailed(offer, result || { reason: 'validation_failed' });
        summary.failed += 1;
        console.log(`[ImageReview] Oferta mantida para nova revisão: ${offer.title} (${result?.reason || 'validation_failed'})`);
      }
    } catch (error) {
      markImageReviewFailed(offer, { reason: 'image_review_error', error: error.message });
      summary.failed += 1;
      console.log(`[ImageReview] Erro ao revisar oferta: ${offer.title} (${error.message})`);
    }
  }

  summary.stats = queueStats();
  return summary;
}

module.exports = { reviewPendingOfferImages };
