const crypto = require('crypto');
const { readJson, writeJson } = require('../storage/jsonStore');
const { normalizeText } = require('../utils/text');

const QUEUE_FILE = 'offers.queue.json';
const SENT_FILE = 'offers.sent.json';
const SKIPPED_FILE = 'offers.skipped.json';
const STATUS_PENDING_REVIEW = 'pending_image_review';
const STATUS_READY = 'ready_to_publish';
const STATUS_REVIEW_FAILED = 'image_review_failed';

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function loadQueue() {
  return readJson(QUEUE_FILE, []);
}

function saveQueue(items) {
  writeJson(QUEUE_FILE, items);
}

function loadSent() {
  return readJson(SENT_FILE, []);
}

function saveSent(items) {
  writeJson(SENT_FILE, items);
}

function loadSkipped() {
  return readJson(SKIPPED_FILE, []);
}

function saveSkipped(items) {
  writeJson(SKIPPED_FILE, items);
}

function normalizeOfferUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

function offerId(offer) {
  if (offer?.id) return offer.id;

  const canonicalUrl = normalizeOfferUrl(offer?.url);
  if (canonicalUrl) return hash(`url:${canonicalUrl}`);

  const title = normalizeText(offer?.title || '');
  const priceText = normalizeText(offer?.priceText || '');
  const rawPrice = Number(offer?.price);
  const price = Number.isFinite(rawPrice) ? rawPrice.toFixed(2) : '';
  const fallback = `${title}|${priceText}|${price}`;
  return hash(fallback || JSON.stringify(offer || {}));
}

function offerStatus(offer) {
  if (offer?.status) return offer.status;
  if (offer?.imageVerified || offer?.source === 'test') return STATUS_READY;
  return STATUS_PENDING_REVIEW;
}

function enqueueOffers(offers) {
  const queue = loadQueue();
  const sent = loadSent();
  const skipped = loadSkipped();
  const known = new Set([...queue.map(offerId), ...sent.map(offerId), ...skipped.map(offerId)]);
  let added = 0;

  for (const raw of offers) {
    if (!raw || typeof raw !== 'object') continue;
    const offer = {
      ...raw,
      id: offerId(raw),
      status: offerStatus(raw),
      imageReviewAttempts: Number(raw.imageReviewAttempts || 0),
      createdAt: raw.createdAt || new Date().toISOString()
    };
    if (!offer.url || known.has(offer.id)) continue;
    queue.push(offer);
    known.add(offer.id);
    added += 1;
  }

  saveQueue(queue);
  return { added, total: queue.length };
}

function getPendingOffers(limit = 1, sourceUrl = null) {
  return loadQueue()
    .filter((item) => item && (item.status === STATUS_READY || item.status === 'pending') && (!sourceUrl || item.sourceUrl === sourceUrl))
    .slice(0, limit);
}

function getReviewOffers(limit = 10, sourceUrl = null, maxAttempts = 3) {
  return loadQueue()
    .filter((item) => {
      if (!item || (sourceUrl && item.sourceUrl !== sourceUrl)) return false;
      if (item.status === STATUS_READY || item.status === 'sent' || item.status === 'skipped') return false;
      return Number(item.imageReviewAttempts || 0) < maxAttempts;
    })
    .slice(0, limit);
}

function updateQueuedOffer(offer, patch = {}) {
  const id = offerId(offer);
  const queue = loadQueue();
  const index = queue.findIndex((item) => offerId(item) === id);
  if (index < 0) return null;
  queue[index] = { ...queue[index], ...patch, id };
  saveQueue(queue);
  return queue[index];
}

function markReadyToPublish(offer, validatedOffer = offer) {
  const clean = { ...validatedOffer };
  delete clean.imageBuffer;
  delete clean.imageContentType;
  return updateQueuedOffer(offer, {
    ...clean,
    status: STATUS_READY,
    imageVerified: true,
    imageReviewAttempts: Number(offer.imageReviewAttempts || 0) + 1,
    imageReviewedAt: new Date().toISOString()
  });
}

function markImageReviewFailed(offer, result = {}) {
  return updateQueuedOffer(offer, {
    status: STATUS_REVIEW_FAILED,
    imageVerified: false,
    imageReviewAttempts: Number(offer.imageReviewAttempts || 0) + 1,
    imageReviewedAt: new Date().toISOString(),
    lastImageReviewReason: result.reason || 'validation_failed'
  });
}

function markSent(offer, result = {}) {
  const id = offerId(offer);
  const queue = loadQueue().filter((item) => offerId(item) !== id);
  const sent = loadSent();
  sent.push({ ...offer, id, status: 'sent', sentAt: new Date().toISOString(), result });
  saveQueue(queue);
  saveSent(sent.slice(-1000));
}

function markSkipped(offer, result = {}) {
  const id = offerId(offer);
  const queue = loadQueue().filter((item) => offerId(item) !== id);
  const skipped = loadSkipped();
  skipped.push({ ...offer, id, status: 'skipped', skippedAt: new Date().toISOString(), result });
  saveQueue(queue);
  saveSkipped(skipped.slice(-1000));
}

function queueStats() {
  const queue = loadQueue();
  return {
    pending: queue.filter((x) => x && !['sent', 'skipped'].includes(x.status)).length,
    readyToPublish: queue.filter((x) => x.status === STATUS_READY).length,
    pendingImageReview: queue.filter((x) => x.status === STATUS_PENDING_REVIEW || x.status === 'pending').length,
    imageReviewFailed: queue.filter((x) => x.status === STATUS_REVIEW_FAILED).length,
    sent: loadSent().length,
    skipped: loadSkipped().length
  };
}

module.exports = {
  enqueueOffers,
  getPendingOffers,
  getReviewOffers,
  markReadyToPublish,
  markImageReviewFailed,
  markSent,
  markSkipped,
  queueStats,
  loadQueue,
  STATUS_PENDING_REVIEW,
  STATUS_READY,
  STATUS_REVIEW_FAILED
};
