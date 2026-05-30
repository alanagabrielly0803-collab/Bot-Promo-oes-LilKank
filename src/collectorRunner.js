require('dotenv').config();
const { collectFromPublicPages, collectFromPublicPage } = require('./sources/publicWebSource');
const { collectFromRssFeeds } = require('./sources/rssSource');
const { enqueueOffers, queueStats } = require('./queue/offerQueue');
const config = require('./config');

async function runCollector() {
  console.log('[Coletor] Iniciando coleta automática de fontes públicas...');
  const offers = [];
  offers.push(...await collectFromPublicPages());
  offers.push(...await collectFromRssFeeds());
  const result = enqueueOffers(offers);
  console.log(`[Coletor] Coleta finalizada. Novas: ${result.added}. Fila total: ${result.total}.`);
  return { collected: offers.length, ...result, stats: queueStats() };
}

async function runCategoryCycle(batchSize = 5) {
  const { publishNextOffers } = require('./publisher/whatsapp');
  console.log('[Coletor] Iniciando varredura por categoria...');
  const summary = {
    categories: 0,
    collected: 0,
    added: 0,
    sent: 0,
    stats: queueStats()
  };

  for (const sourceUrl of config.publicSourceUrls) {
    try {
      console.log(`[Coletor] Categoria/fonte: ${sourceUrl}`);
      const offers = await collectFromPublicPage(sourceUrl);
      const result = enqueueOffers(offers);
      const publishResult = await publishNextOffers(batchSize, null, sourceUrl);
      summary.categories += 1;
      summary.collected += offers.length;
      summary.added += result.added;
      summary.sent += publishResult.sent;
      summary.stats = queueStats();
      console.log(
        `[Coletor] Categoria finalizada: ${sourceUrl}. ` +
        `Coletadas: ${offers.length}. Novas: ${result.added}. Enviadas: ${publishResult.sent}.`
      );
    } catch (error) {
      console.error(`[Coletor] Erro na categoria ${sourceUrl}:`, error.response?.status || error.message);
    }
  }

  console.log(
    `[Coletor] Varredura por categoria finalizada. ` +
    `Categorias: ${summary.categories}. Coletadas: ${summary.collected}. Novas: ${summary.added}. Enviadas: ${summary.sent}.`
  );

  return summary;
}

if (require.main === module) {
  runCollector().catch((error) => {
    console.error('[Coletor] Falha geral:', error);
    process.exit(1);
  });
}

module.exports = { runCollector, runCategoryCycle };
