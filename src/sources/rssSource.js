const Parser = require('rss-parser');
const config = require('../config');
const { isShopeeUrl, enrichOfferFromUrl } = require('./offerExtractor');

const parser = new Parser({
  timeout: 25000,
  headers: {
    'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)'
  }
});

function extractShopeeLinksFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return matches.filter(isShopeeUrl);
}

async function collectFromRssFeed(feedUrl) {
  console.log(`[Coletor] Lendo RSS: ${feedUrl}`);
  const feed = await parser.parseURL(feedUrl);
  const offers = [];
  const seen = new Set();

  for (const item of feed.items || []) {
    const text = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''} ${item.link || ''}`;
    const links = extractShopeeLinksFromText(text);
    for (const link of links) {
      if (seen.has(link)) continue;
      seen.add(link);
      const offer = await enrichOfferFromUrl(link, text);
      if (offer) offers.push({ ...offer, sourceUrl: feedUrl });
      if (offers.length >= config.maxLinksPerSource) break;
    }
    if (offers.length >= config.maxLinksPerSource) break;
  }

  console.log(`[Coletor] RSS ${feedUrl}: ${offers.length} ofertas aproveitáveis.`);
  return offers;
}

async function collectFromRssFeeds() {
  const results = [];
  for (const url of config.rssSourceUrls) {
    try {
      const offers = await collectFromRssFeed(url);
      results.push(...offers);
    } catch (error) {
      console.error(`[Coletor] Erro no RSS ${url}:`, error.message);
    }
  }
  return results;
}

module.exports = { collectFromRssFeeds, collectFromRssFeed };
