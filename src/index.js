require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const { connectWhatsApp, publishNextOffers, sendOfferDirect, getWhatsAppStatus, waitForWhatsAppReady } = require('./publisher/whatsapp');
const { runCollector, runCategoryCycle } = require('./collectorRunner');
const { collectFromPublicPages } = require('./sources/publicWebSource');
const { queueStats, enqueueOffers } = require('./queue/offerQueue');

const app = express();
app.use(express.json({ limit: '1mb' }));
let schedulersStarted = false;

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

function getRequestApiKey(req) {
  return String(
    req.get('x-api-key') ||
    req.query.api_key ||
    req.body?.apiKey ||
    ''
  ).trim();
}

function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    res.status(503).json({
      ok: false,
      error: 'api_key_not_configured',
      message: 'Configure API_KEY no Render antes de usar endpoints POST.'
    });
    return;
  }

  if (getRequestApiKey(req) !== config.apiKey) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  next();
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function clampLimit(value, fallback = 1, max = 50) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
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

async function startSchedulers() {
  if (schedulersStarted) return;
  schedulersStarted = true;

  if (config.seedTestOfferOnStart) {
    enqueueOffers([buildTestOffer()]);
    console.log('[Bootstrap] Oferta de teste adicionada à fila.');
  }

  if (config.autoStartCollector) {
    console.log(`[Scheduler] Coletor por categoria iniciado. Intervalo: ${config.discoveryIntervalMinutes} min.`);
    runCategoryCycle(config.maxPostsPerRun).catch((error) => console.error('[Scheduler] Erro inicial na coleta por categoria:', error.message));
    cron.schedule(`*/${config.discoveryIntervalMinutes} * * * *`, () => {
      runCategoryCycle(config.maxPostsPerRun).catch((error) => console.error('[Scheduler] Erro na coleta por categoria:', error.message));
    });
  }

  if (config.autoStartPublisher) {
    console.log(`[Scheduler] Publicador iniciado. Intervalo: ${config.postIntervalMinutes} min.`);
    publishNextOffers().catch((error) => console.error('[Scheduler] Erro inicial ao publicar:', error.message));
    cron.schedule(`*/${config.postIntervalMinutes} * * * *`, () => {
      publishNextOffers().catch((error) => console.error('[Scheduler] Erro ao publicar:', error.message));
    });
  }
}

app.get('/', (req, res) => {
  res.redirect(302, '/qr');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, stats: queueStats(), time: new Date().toISOString() });
});

app.get('/qr', (req, res) => {
  const status = getWhatsAppStatus();
  const svg = status.qrSvg || '';
  const png = status.qrPng || '';
  const pairingCode = status.pairingCode || '';
  const loginMethod = status.loginMethod || 'qr';
  const showQr = Boolean(png || svg);
  const showPairing = Boolean(pairingCode) || loginMethod === 'pairing';
  const title = status.connectionState === 'open'
    ? 'WhatsApp conectado'
    : showQr
      ? 'Escaneie o QR do WhatsApp'
      : showPairing
        ? 'Código de pareamento do WhatsApp'
      : 'Aguardando QR do WhatsApp';
  const refreshSeconds = showQr ? 30 : 5;

  if (!showQr && !showPairing) {
    res.type('html').send(`<!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <meta http-equiv="refresh" content="5" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${title}</title>
          <style>
            body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
            .card { max-width: 640px; width: 100%; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; box-shadow: 0 12px 30px rgba(0,0,0,.35); }
            code, pre { white-space: pre-wrap; word-break: break-word; }
            .muted { color: #94a3b8; }
            .pair-wrap { margin-top: 16px; background: #0b1120; border: 1px solid #334155; border-radius: 12px; padding: 16px 18px; }
            .pair-code { font-size: 2rem; letter-spacing: 0.25em; font-weight: 700; color: #f8fafc; word-break: break-word; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>${title}</h1>
            <p class="muted">Esta página atualiza automaticamente a cada 5 segundos.</p>
            <p>Se o QR ainda não apareceu, aguarde o WhatsApp gerar a sessão no Render.</p>
            <p>Status atual: <strong>${status.connectionState}</strong></p>
            <p>Atualizado em: <strong>${status.qrUpdatedAt || 'ainda não'}</strong></p>
            <p>Modo de login: <strong>${status.loginMethod || 'qr'}</strong></p>
            ${pairingCode ? `<div class="pair-wrap"><div class="muted">Código de pareamento</div><div class="pair-code">${pairingCode}</div><div class="muted">Digite esse código no WhatsApp do celular.</div></div>` : ''}
          </div>
        </body>
      </html>`);
    return;
  }

  const qrSrc = png || (svg ? `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` : '');
  res.type('html').send(`<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="refresh" content="${status.connectionState === 'open' ? '30' : refreshSeconds}" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
          .card { max-width: 720px; width: 100%; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; box-shadow: 0 12px 30px rgba(0,0,0,.35); text-align: center; }
          .qr-wrap { background: #fff; padding: 18px; border-radius: 16px; display: inline-block; }
          .pair-wrap { margin-top: 16px; background: #0b1120; border: 1px solid #334155; border-radius: 12px; padding: 16px 18px; }
          img { max-width: 100%; height: auto; display: block; }
          .muted { color: #94a3b8; }
          .ok { color: #4ade80; font-weight: 700; }
          code { background: #0b1120; padding: 2px 6px; border-radius: 6px; }
          .pair-code { font-size: 2rem; letter-spacing: 0.25em; font-weight: 700; color: #f8fafc; word-break: break-word; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>${title}</h1>
          <p class="muted">${showQr ? 'Abra este endereço no navegador e escaneie o QR com a câmera do WhatsApp.' : 'Abra este endereço no navegador e escaneie o QR pelo WhatsApp em <code>Aparelhos conectados</code>.'}</p>
          ${showQr ? `<div class="qr-wrap"><img alt="QR Code do WhatsApp" src="${qrSrc}" width="360" height="360" /></div>` : ''}
          ${!showQr && showPairing ? `<div class="pair-wrap"><div class="muted">Código de pareamento</div><div class="pair-code">${pairingCode || 'Aguardando código...'}</div><div class="muted">Digite esse código no WhatsApp do celular.</div></div>` : ''}
          <p>Status atual: <strong class="${status.connectionState === 'open' ? 'ok' : ''}">${status.connectionState}</strong></p>
          <p class="muted">Atualizado em: ${status.qrUpdatedAt || 'ainda não'}</p>
          <p class="muted">Modo de login: ${status.loginMethod || 'qr'}</p>
          <p class="muted">Se a página mudar para <code>open</code>, o bot já conectou.</p>
        </div>
      </body>
    </html>`);
});

app.get('/sync', (req, res) => {
  res.redirect(302, '/qr');
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    config: {
      postIntervalMinutes: config.postIntervalMinutes,
      discoveryIntervalMinutes: config.discoveryIntervalMinutes,
      apiProtected: Boolean(config.apiKey),
      schedulersStarted
    },
    whatsapp: getWhatsAppStatus(),
    stats: queueStats()
  });
});

app.use('/api', requireApiKey);

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

app.post('/api/test-send', asyncRoute(async (req, res) => {
  const result = enqueueOffers([buildTestOffer()]);
  const publishResult = await publishNextOffers(1);
  res.json({ ok: true, message: 'Oferta de teste enfileirada e tentativa de envio realizada.', queue: result, publish: publishResult });
}));

app.post('/api/test-launch', asyncRoute(async (req, res) => {
  const result = enqueueOffers([buildTestOffer()]);
  const publishResult = await publishNextOffers(1);
  res.json({
    ok: true,
    message: 'Teste rápido de lançamento executado.',
    queue: result,
    publish: publishResult
  });
}));

app.post('/api/collect-send', asyncRoute(async (req, res) => {
  const limit = clampLimit(req.body?.limit, 1, 20);
  const { collectResult, publishResult } = await runCollectAndPublish(limit);
  res.json({
    ok: true,
    message: 'Coleta e envio executados.',
    collect: collectResult,
    publish: publishResult
  });
}));

app.post('/api/collect-send-20', asyncRoute(async (req, res) => {
  const limit = clampLimit(req.body?.limit, 20, 50);
  const { collectResult, publishResult } = await runCategoryCollectAndPublish(limit);
  res.json({
    ok: true,
    message: `Coleta por categoria e envio em blocos de até ${limit} executados.`,
    collect: collectResult,
    publish: publishResult
  });
}));

app.post('/api/collect-send-force', asyncRoute(async (req, res) => {
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
}));

app.use((error, req, res, next) => {
  console.error('[HTTP] Erro na rota:', error.stack || error.message);
  res.status(500).json({ ok: false, error: 'internal_error', message: error.message });
});

app.listen(config.port, () => {
  console.log(`[HTTP] Servidor rodando na porta ${config.port}.`);
  console.log('[HTTP] Rotas: /, /health, /qr, /status, POST /api/offers, POST /api/test-offer, POST /api/test-send, POST /api/test-launch, POST /api/collect-send, POST /api/collect-send-20, POST /api/collect-send-force');
});

async function bootstrap() {
  try {
    await connectWhatsApp(startSchedulers);
    const ready = await waitForWhatsAppReady(120000);
    if (ready) {
      await startSchedulers();
      return;
    }
    console.warn('[Bootstrap] WhatsApp não ficou pronto em 120s. O servidor continua online e os agendadores iniciarão quando conectar.');
  } catch (error) {
    console.error('[Bootstrap] Falha na inicialização do WhatsApp:', error.message);
  }
}

bootstrap().catch((error) => {
  console.error('[Bootstrap] Erro inesperado:', error.message);
});
