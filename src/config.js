require('dotenv').config();

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  port: number(process.env.PORT, 10000),
  apiKey: String(process.env.API_KEY || '').trim(),
  whatsappGroupId: String(process.env.WHATSAPP_GROUP_ID || '').trim(),
  whatsappAuthFolder: process.env.WHATSAPP_AUTH_FOLDER || './storage/auth_publico',
  whatsappLoginMethod: String(process.env.WHATSAPP_LOGIN_METHOD || 'qr').toLowerCase(),
  whatsappPairingPhone: String(process.env.WHATSAPP_PAIRING_PHONE || '').trim(),
  resetWhatsAppAuthOnStart: bool(process.env.RESET_WHATSAPP_AUTH_ON_START, false),
  sendProductImage: bool(process.env.SEND_PRODUCT_IMAGE, true),
  allowLinkOnly: bool(process.env.ALLOW_LINK_ONLY, true),
  requireVerifiedImage: bool(process.env.REQUIRE_VERIFIED_IMAGE, false),
  allowUntrustedImageTesting: bool(process.env.ALLOW_UNTRUSTED_IMAGE_TESTING, false),
  allowPageImageAsVerified: bool(process.env.ALLOW_PAGE_IMAGE_AS_VERIFIED, true),
  imageExtractionMode: String(process.env.IMAGE_EXTRACTION_MODE || 'page_first'),
  imageMinConfidence: number(process.env.IMAGE_MIN_CONFIDENCE, 70),
  imageMinBytes: number(process.env.IMAGE_MIN_BYTES, 10000),
  imageMinWidth: number(process.env.IMAGE_MIN_WIDTH, 180),
  imageMinHeight: number(process.env.IMAGE_MIN_HEIGHT, 180),
  imageRequireValidHttp: bool(process.env.IMAGE_REQUIRE_VALID_HTTP, true),
  playwrightImageFallback: bool(process.env.PLAYWRIGHT_IMAGE_FALLBACK, true),
  playwrightTimeoutMs: number(process.env.PLAYWRIGHT_TIMEOUT_MS, 30000),
  publishOnlyValidated: bool(process.env.PUBLISH_ONLY_VALIDATED, true),
  autoStartPublisher: bool(process.env.AUTO_START_PUBLISHER, false),
  autoStartCollector: bool(process.env.AUTO_START_COLLECTOR, false),
  discoveryIntervalMinutes: number(process.env.DISCOVERY_INTERVAL_MINUTES, 180),
  postIntervalMinutes: number(process.env.POST_INTERVAL_MINUTES, 60),
  maxPostsPerRun: number(process.env.MAX_POSTS_PER_RUN, 1),
  maxLinksPerSource: number(process.env.MAX_LINKS_PER_SOURCE, 20),
  googleImageSearchApiKey: process.env.GOOGLE_IMAGE_SEARCH_API_KEY || '',
  googleImageSearchCx: process.env.GOOGLE_IMAGE_SEARCH_CX || '',
  publicSourceUrls: list(process.env.PUBLIC_SOURCE_URLS),
  rssSourceUrls: list(process.env.RSS_SOURCE_URLS),
  offerKeywords: list(process.env.OFFER_KEYWORDS).map((x) => x.toLowerCase()),
  blockKeywords: list(process.env.BLOCK_KEYWORDS).map((x) => x.toLowerCase()),
  minPrice: number(process.env.MIN_PRICE, 1),
  maxPrice: number(process.env.MAX_PRICE, 100),
  dataDir: process.env.DATA_DIR || './data',
  seedTestOfferOnStart: bool(process.env.SEED_TEST_OFFER_ON_START, false)
};

module.exports = config;
