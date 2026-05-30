const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const config = require('../config');
const { buildOfferMessage } = require('./messageBuilder');
const { getPendingOffers, markSent, markSkipped, queueStats, loadQueue } = require('../queue/offerQueue');
const { runCollector } = require('../collectorRunner');
const { enrichAndValidateOffer, closePlaywrightBrowser } = require('../services/productQualityGate');

let sock;
let paused = false;
let currentQr = {
  value: '',
  svg: '',
  updatedAt: null
};
let connectionState = 'idle';

function setCurrentQr(value) {
  currentQr.value = value || '';
  currentQr.updatedAt = new Date().toISOString();
}

async function generateQrSvg(value) {
  if (!value) return '';
  return QRCode.toString(value, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsappAuthFolder);
  const { version } = await fetchLatestBaileysVersion();
  connectionState = 'connecting';

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    version,
    browser: ['Ofertas Casa Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionState = 'qr';
      setCurrentQr(qr);
      try {
        currentQr.svg = await generateQrSvg(qr);
      } catch (error) {
        console.error('[WhatsApp] Falha ao gerar QR SVG:', error.message);
        currentQr.svg = '';
      }
      console.log('[WhatsApp] Escaneie o QR Code abaixo:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionState = 'open';
      setCurrentQr('');
      currentQr.svg = '';
      console.log('[WhatsApp] Conectado com sucesso.');
    }

    if (connection === 'close') {
      connectionState = 'close';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Conexão fechada.', `status=${statusCode || 'n/a'}.`, shouldReconnect ? 'Reconectando...' : 'Sessão encerrada.');
      if (lastDisconnect?.error) {
        console.error('[WhatsApp] Erro de desconexão:', lastDisconnect.error.message || lastDisconnect.error);
      }
      if (shouldReconnect) {
        setTimeout(() => {
          connectWhatsApp().catch((error) => {
            console.error('[WhatsApp] Falha ao reconectar:', error.message);
          });
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      await handleCommand(msg).catch((error) => console.error('[WhatsApp] Erro em comando:', error.message));
    }
  });

  return sock;
}

function getWhatsAppStatus() {
  return {
    connectionState,
    qr: currentQr.value,
    qrSvg: currentQr.svg,
    qrUpdatedAt: currentQr.updatedAt
  };
}

function getMessageText(msg) {
  return msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    '';
}

async function reply(jid, text) {
  await sock.sendMessage(jid, { text });
}

async function handleCommand(msg) {
  const jid = msg.key.remoteJid;
  const text = getMessageText(msg).trim();
  if (!text.startsWith('/')) return;

  const [command] = text.split(/\s+/);

  if (command === '/status') {
    const stats = queueStats();
    await reply(jid, `Status: ${paused ? 'pausado' : 'ativo'}\nFila: ${stats.pending}\nEnviadas: ${stats.sent}\nGrupo alvo: ${config.whatsappGroupId || 'não configurado'}`);
    return;
  }

  if (command === '/pausar') {
    paused = true;
    await reply(jid, 'Bot pausado.');
    return;
  }

  if (command === '/ativar') {
    paused = false;
    await reply(jid, 'Bot ativado.');
    return;
  }

  if (command === '/fila') {
    const pending = loadQueue().filter((item) => item.status === 'pending').slice(0, 5);
    if (!pending.length) {
      await reply(jid, 'Fila vazia. Use /coletar para buscar novas ofertas nas fontes públicas.');
      return;
    }
    await reply(jid, pending.map((offer, i) => `${i + 1}. ${offer.title}\n${offer.url}`).join('\n\n'));
    return;
  }

  if (command === '/coletar') {
    await reply(jid, 'Iniciando coleta agora...');
    const result = await runCollector();
    await reply(jid, `Coleta finalizada. Coletadas: ${result.collected}. Novas na fila: ${result.added}. Pendentes: ${result.stats.pending}.`);
    return;
  }

  if (command === '/postar' || command === '/testeoferta') {
    const result = await publishNextOffers(1, jid);
    await reply(jid, `Postagem manual finalizada. Enviadas: ${result.sent}.`);
    return;
  }

  if (command === '/grupos') {
    const groups = await sock.groupFetchAllParticipating();
    const lines = Object.values(groups).map((g) => `${g.subject}\n${g.id}`);
    await reply(jid, lines.length ? lines.join('\n\n') : 'Nenhum grupo encontrado.');
    return;
  }

  if (command === '/fontes') {
    await reply(jid, `Fontes HTML:\n${config.publicSourceUrls.join('\n') || 'nenhuma'}\n\nFeeds RSS:\n${config.rssSourceUrls.join('\n') || 'nenhum'}`);
    return;
  }
}

async function sendOffer(targetJid, offer) {
  const caption = buildOfferMessage(offer);

  if (config.requireVerifiedImage && !offer.imageVerified && !config.allowUntrustedImageTesting) {
    return { mode: 'skipped_no_verified_image', reason: 'missing_verified_image' };
  }

  if (config.sendProductImage && (offer.imageBuffer || offer.imageUrl)) {
    try {
      if (offer.imageBuffer) {
        await sock.sendMessage(targetJid, {
          image: offer.imageBuffer,
          caption
        });
      } else {
        const imageResponse = await axios.get(offer.imageUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: {
            'user-agent': 'Mozilla/5.0 OfferCollector/1.0 (+local bot)',
            accept: 'image/*,*/*'
          },
          validateStatus: (status) => status >= 200 && status < 500
        });

        if (imageResponse.status >= 400) {
          throw new Error(`download_image_http_${imageResponse.status}`);
        }

        await sock.sendMessage(targetJid, {
          image: Buffer.from(imageResponse.data),
          caption
        });
      }
      return { mode: 'image' };
    } catch (error) {
      console.warn('[WhatsApp] Falha ao enviar imagem.', error.message);
      if (config.requireVerifiedImage && !config.allowUntrustedImageTesting) {
        return { mode: 'skipped_no_verified_image', reason: 'image_download_failed' };
      }
    }
  }

  if (config.requireVerifiedImage && !config.allowUntrustedImageTesting) {
    return { mode: 'skipped_no_verified_image', reason: 'missing_verified_image' };
  }

  await sock.sendMessage(targetJid, { text: caption });
  return { mode: 'text' };
}

async function validateForPublish(offer) {
  if (!offer) return null;
  if (!config.publishOnlyValidated) return offer;
  const result = await enrichAndValidateOffer(offer);
  if (!result?.ok) return null;
  return result.offer;
}

async function sendOfferDirect(targetJid, offer) {
  if (!sock) return { sent: false, reason: 'whatsapp_not_connected' };
  if (!targetJid) return { sent: false, reason: 'missing_group_id' };
  const normalizedOffer = await validateForPublish(offer);
  if (!normalizedOffer) return { sent: false, reason: 'validation_failed' };
  const result = await sendOffer(targetJid, normalizedOffer);
  return { sent: true, ...result };
}

async function publishNextOffers(limit = config.maxPostsPerRun, overrideJid = null, sourceUrl = null) {
  if (!sock) return { sent: 0, reason: 'whatsapp_not_connected' };
  if (paused && !overrideJid) return { sent: 0, reason: 'paused' };

  const targetJid = overrideJid || config.whatsappGroupId;
  if (!targetJid) {
    console.warn('[Publisher] WHATSAPP_GROUP_ID não configurado. Use /grupos para descobrir o ID.');
    return { sent: 0, reason: 'missing_group_id' };
  }

  const offers = getPendingOffers(limit, sourceUrl);
  let sent = 0;

  for (const offer of offers) {
    try {
      const normalizedOffer = await validateForPublish(offer);
      if (!normalizedOffer) {
        markSkipped(offer, { reason: 'validation_failed' });
        console.log(`[Publisher] Oferta ignorada pelo quality gate: ${offer.title}`);
        continue;
      }

      const result = await sendOffer(targetJid, normalizedOffer);
      const persistedOffer = { ...normalizedOffer };
      delete persistedOffer.imageBuffer;
      if (result.mode === 'skipped_no_verified_image') {
        markSkipped(persistedOffer, result);
        console.log(`[Publisher] Oferta ignorada por falta de imagem verificada: ${normalizedOffer.title}`);
        continue;
      }

      markSent(persistedOffer, result);
      sent += 1;
      console.log(`[Publisher] Oferta enviada: ${normalizedOffer.title}`);
    } catch (error) {
      console.error('[Publisher] Falha ao enviar oferta:', error.message);
    }
  }

  return { sent };
}

process.on('exit', () => {
  closePlaywrightBrowser().catch(() => {});
});

module.exports = { connectWhatsApp, publishNextOffers, sendOfferDirect, getWhatsAppStatus };
