require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const { connectWhatsApp, publishNextOffers, sendOfferDirect } = require('./publisher/whatsapp');
const { runCollector, runCategoryCycle } = require('./collectorRunner');
const { collectFromPublicPages } = require('./sources/publicWebSource');
const { queueStats, enqueueOffers } = require('./queue/offerQueue');

const app = express();
app.use(express.json({ limit: '1mb' }));

function buildTestOffer() {
  const nonce = Date.now();
  return {
    title: 'Organizador de cozinha multifuncional - oferta de teste',
    price: 24.9,
    priceText: 'R$ 24,90',
    imageUrl: 'https://placehold.co/800x800/png?text=Oferta+de+Teste',
    url: `https://shopee.com.br/?test=${nonce}`,
    source: 'test'
  };
}

async function runCollectAndPublish(limit = 1) {
  const collectResult = await runCollector();
  const publishResult = await publishNextOffers(limit);
  return { collectResult, publishResult };
}

async function runCategoryCollectAndPublish(limit = 5) {
  const collectResult = await runCategoryCycle(limit);
  return { collectResult, publishResult: { sent: collectResult.sent || 0 } };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, stats: queueStats(), time: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  res.json({ ok: true, config: { postIntervalMinutes: config.postIntervalMinutes, discoveryIntervalMinutes: config.discoveryIntervalMinutes }, stats: queueStats() });
});

app.post('/api/offers', (req, res) => {
  const body = req.body || {};
  const offer = {
    title: body.title || body.name || 'Oferta Shopee',
    price: body.price || null,
    priceText: body.priceText || null,
    imageUrl: body.imageUrl || body.image || null,
    url: body.url || body.link,
    source: 'api',
    rawText: body.rawText || ''
  };

  if (!offer.url) {
    res.status(400).json({ ok: false, error: 'url/link obrigatório' });
    return;
  }

  const result = enqueueOffers([offer]);
  res.json({ ok: true, ...result });
});

app.post('/api/test-offer', (req, res) => {
  const result = enqueueOffers([buildTestOffer()]);

  res.json({ ok: true, message: 'Oferta de teste enfileirada.', ...result });
});

app.post('/api/test-send', async (req, res) => {
  const result = enqueueOffers([buildTestOffer()]);

  const publishResult = await publishNextOffers(1);
  res.json({ ok: true, message: 'Oferta de teste enfileirada e tentativa de envio realizada.', queue: result, publish: publishResult });
});

app.post('/api/test-launch', async (req, res) => {
  const result = enqueueOffers([buildTestOffer()]);
  const publishResult = await publishNextOffers(1);
  res.json({
    ok: true,
    message: 'Teste rápido de lançamento executado.',
    queue: result,
    publish: publishResult
  });
});

app.post('/api/collect-send', async (req, res) => {
  const { collectResult, publishResult } = await runCollectAndPublish(1);
  res.json({
    ok: true,
    message: 'Coleta e envio executados.',
    collect: collectResult,
    publish: publishResult
  });
});

app.post('/api/collect-send-20', async (req, res) => {
  const { collectResult, publishResult } = await runCategoryCollectAndPublish(5);
  res.json({
    ok: true,
    message: 'Coleta por categoria e envio em blocos executados.',
    collect: collectResult,
    publish: publishResult
  });
});

app.post('/api/collect-send-force', async (req, res) => {
  const offers = await collectFromPublicPages();
  const offer = offers[0] || null;

  if (!offer) {
    res.json({ ok: true, message: 'Nenhuma oferta encontrada nas fontes públicas.', collect: { collected: 0 }, publish: { sent: 0 } });
    return;
  }

  const publishResult = await sendOfferDirect(config.whatsappGroupId, offer);
  res.json({
    ok: true,
    message: 'Oferta pública enviada diretamente.',
    collect: { collected: offers.length },
    publish: publishResult,
    offer: {
      title: offer.title,
      priceText: offer.priceText,
      imageUrl: Boolean(offer.imageUrl),
      url: offer.url
    }
  });
});

app.listen(config.port, () => {
  console.log(`[HTTP] Servidor rodando na porta ${config.port}.`);
  console.log('[HTTP] Rotas: /health, /status, POST /api/offers, POST /api/test-offer, POST /api/test-send, POST /api/test-launch, POST /api/collect-send, POST /api/collect-send-20, POST /api/collect-send-force');
});

(async () => {
  await connectWhatsApp();

  if (config.seedTestOfferOnStart) {
    enqueueOffers([buildTestOffer()]);
    console.log('[Bootstrap] Oferta de teste adicionada à fila.');
  }

  if (config.autoStartCollector) {
    console.log(`[Scheduler] Coletor por categoria iniciado. Intervalo: ${config.discoveryIntervalMinutes} min.`);
    await runCategoryCycle(5).catch((error) => console.error('[Scheduler] Erro inicial na coleta por categoria:', error.message));
    cron.schedule(`*/${config.discoveryIntervalMinutes} * * * *`, () => {
      runCategoryCycle(5).catch((error) => console.error('[Scheduler] Erro na coleta por categoria:', error.message));
    });
  }

  if (config.autoStartPublisher) {
    console.log(`[Scheduler] Publicador iniciado. Intervalo: ${config.postIntervalMinutes} min.`);
    await publishNextOffers().catch((error) => console.error('[Scheduler] Erro inicial ao publicar:', error.message));
    cron.schedule(`*/${config.postIntervalMinutes} * * * *`, () => {
      publishNextOffers().catch((error) => console.error('[Scheduler] Erro ao publicar:', error.message));
    });
  }
})();
