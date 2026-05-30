const crypto = require('crypto');
const { readJson, writeJson } = require('../storage/jsonStore');
const { normalizeText } = require('../utils/text');

const QUEUE_FILE = 'offers.queue.json';
const SENT_FILE = 'offers.sent.json';
const SKIPPED_FILE = 'offers.skipped.json';

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

function enqueueOffers(offers) {
  const queue = loadQueue();
  const sent = loadSent();
  const skipped = loadSkipped();
  const known = new Set([...queue.map(offerId), ...sent.map(offerId), ...skipped.map(offerId)]);
  let added = 0;

  for (const raw of offers) {
    const offer = { ...raw, id: offerId(raw), status: 'pending', createdAt: raw.createdAt || new Date().toISOString() };
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
    .filter((item) => item.status === 'pending' && (!sourceUrl || item.sourceUrl === sourceUrl))
    .slice(0, limit);
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
  return {
    pending: loadQueue().filter((x) => x.status === 'pending').length,
    sent: loadSent().length,
    skipped: loadSkipped().length
  };
}

module.exports = { enqueueOffers, getPendingOffers, markSent, markSkipped, queueStats, loadQueue };
