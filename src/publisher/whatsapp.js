const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const config = require('../config');
const { buildOfferMessage } = require('./messageBuilder');
const { getPendingOffers, markSent, markSkipped, markImageReviewFailed, queueStats, loadQueue } = require('../queue/offerQueue');
const { runCollector } = require('../collectorRunner');
const { enrichAndValidateOffer, closePlaywrightBrowser } = require('../services/productQualityGate');

let sock;
let paused = false;
let currentQr = {
  value: '',
  svg: '',
  png: '',
  updatedAt: null
};
let currentPairingCode = {
  value: '',
  updatedAt: null
};
let connectionState = 'idle';
let pairingRequested = false;
let pairingRefreshTimer = null;
let reconnectTimer = null;
let connectInFlight = false;
let reconnectAttempts = 0;
let lastPairingRequestAt = 0;
let onOpenCallback = null;
const groupMetadataCache = new Map();
const GROUP_METADATA_TTL_MS = 5 * 60 * 1000;
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const PAIRING_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const PAIRING_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

function getSocketIdentityId() {
  const currentId = String(sock?.authState?.creds?.me?.id || '').trim();
  if (currentId) return currentId;

  const sockUserId = String(sock?.user?.id || sock?.user?.jid || '').trim();
  if (sockUserId && sock?.authState?.creds) {
    sock.authState.creds.me = {
      ...(sock.authState.creds.me || {}),
      id: sockUserId
    };
    return sockUserId;
  }

  return '';
}

async function waitForWhatsAppReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = connectionState === 'open' && getSocketIdentityId();
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function getPublicBaseUrl() {
  return String(
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    process.env.SERVICE_URL ||
    process.env.BASE_URL ||
    ''
  ).replace(/\/+$/, '');
}

function getPairingPageUrl() {
  const baseUrl = getPublicBaseUrl();
  return baseUrl ? `${baseUrl}/qr` : '';
}

async function resetAuthFolderIfNeeded() {
  if (!config.resetWhatsAppAuthOnStart) return;

  const folder = path.resolve(config.whatsappAuthFolder);
  if (!folder || folder === path.resolve('.') || folder.length < 5) {
    throw new Error(`Recusando limpeza de auth em caminho inseguro: ${folder}`);
  }

  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  console.log(`[WhatsApp] Sessão limpa em ${folder} para novo pareamento.`);
}

function setCurrentQr(value) {
  currentQr.value = value || '';
  currentQr.updatedAt = value ? new Date().toISOString() : null;
}

function setCurrentPairingCode(value) {
  currentPairingCode.value = value || '';
  currentPairingCode.updatedAt = value ? new Date().toISOString() : null;
}

function getPairingCodeAgeMs() {
  if (!currentPairingCode.updatedAt) return null;
  const age = Date.now() - new Date(currentPairingCode.updatedAt).getTime();
  return Number.isFinite(age) ? age : null;
}

function isPairingCodeExpired() {
  const age = getPairingCodeAgeMs();
  return age !== null && age > PAIRING_CODE_TTL_MS;
}

function clearPairingRefreshTimer() {
  if (pairingRefreshTimer) {
    clearInterval(pairingRefreshTimer);
    pairingRefreshTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function disposeCurrentSocket() {
  if (!sock) return;

  try { sock.ev?.removeAllListeners?.(); } catch {}
  try { sock.ws?.removeAllListeners?.(); } catch {}
  try { sock.ws?.close?.(); } catch {}

  sock = undefined;
}

function isPairingOrQrFailure(reason) {
  return /qr refs attempts ended|pair|pairing|408|timed out|timeout/i.test(String(reason || ''));
}

function getReconnectDelayMs(statusCode, reason = 'unknown') {
  if (statusCode === DisconnectReason.connectionClosed) return 15000;

  if (statusCode === 408 || isPairingOrQrFailure(reason)) {
    const delay = Math.min(60000 * Math.max(1, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    return delay;
  }

  const delay = Math.min(10000 * Math.max(1, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
  return delay;
}

function scheduleReconnect(statusCode, reason = 'unknown') {
  if (reconnectTimer) return;

  const shouldReconnect = ![
    DisconnectReason.loggedOut,
    DisconnectReason.connectionReplaced,
    DisconnectReason.multideviceMismatch
  ].includes(statusCode);

  if (!shouldReconnect) {
    console.warn(`[WhatsApp] Reconexão automática desativada para status=${statusCode || 'n/a'} (${reason}). Limpe/repareie a sessão para continuar.`);
    return;
  }

  reconnectAttempts += 1;
  const delayMs = getReconnectDelayMs(statusCode, reason);

  console.log(`[WhatsApp] Agendando reconexão em ${Math.round(delayMs / 1000)}s (${reason}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (connectInFlight) {
      scheduleReconnect(statusCode, 'connect_in_flight');
      return;
    }
    connectWhatsApp().catch((error) => {
      console.error('[WhatsApp] Falha ao reconectar:', error.message);
    });
  }, delayMs);
  reconnectTimer.unref?.();
}

function startPairingRefreshTimer() {
  if (pairingRefreshTimer || !canRequestPairingCode()) return;
  pairingRefreshTimer = setInterval(() => {
    if (sock?.authState?.creds?.registered) return;
    if (!currentPairingCode.value || isPairingCodeExpired()) {
      pairingRequested = false;
      setCurrentPairingCode('');
      maybeRequestPairingCode('refresh').catch((error) => {
        console.error('[WhatsApp] Erro ao renovar código de pareamento:', error.message);
      });
    }
  }, PAIRING_REFRESH_INTERVAL_MS);
  pairingRefreshTimer.unref?.();
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeJid(value) {
  return String(value || '').trim();
}

function getCachedGroupMetadata(jid) {
  const key = normalizeJid(jid);
  const cached = groupMetadataCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > GROUP_METADATA_TTL_MS) {
    groupMetadataCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedGroupMetadata(jid, value) {
  const key = normalizeJid(jid);
  if (!key || !value) return;
  groupMetadataCache.set(key, {
    updatedAt: Date.now(),
    value
  });
}

function canRequestPairingCode() {
  return ['pairing', 'both'].includes(config.whatsappLoginMethod);
}

function getBrowserConfig() {
  if (canRequestPairingCode()) {
    return Browsers?.macOS ? Browsers.macOS('Google Chrome') : ['Mac OS', 'Chrome', '14.4.1'];
  }

  return Browsers?.macOS ? Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '14.4.1'];
}

async function maybeRequestPairingCode(reason = 'manual') {
  if (!sock) return;
  if (!canRequestPairingCode()) return;
  if (sock.authState?.creds?.registered) return;
  if (pairingRequested) return;
  if (currentPairingCode.value && !isPairingCodeExpired()) return;

  const now = Date.now();
  if (lastPairingRequestAt && now - lastPairingRequestAt < PAIRING_REQUEST_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((PAIRING_REQUEST_COOLDOWN_MS - (now - lastPairingRequestAt)) / 1000);
    console.warn(`[WhatsApp] Aguardando cooldown para novo código de pareamento (${remainingSeconds}s restantes).`);
    return;
  }

  const phoneNumber = normalizePhoneNumber(config.whatsappPairingPhone);
  if (!phoneNumber) {
    console.warn('[WhatsApp] WHATSAPP_PAIRING_PHONE não configurado. Use apenas QR ou preencha o telefone para o código.');
    return;
  }

  pairingRequested = true;
  lastPairingRequestAt = now;
  try {
    console.log(`[WhatsApp] Solicitando código de pareamento (${reason})...`);
    const code = await sock.requestPairingCode(phoneNumber);
    setCurrentPairingCode(code);
    console.log(`[WhatsApp] Código de pareamento: ${code}`);
    const pairingPageUrl = getPairingPageUrl();
    if (pairingPageUrl) {
      console.log(`[WhatsApp] Abra a página de pareamento em: ${pairingPageUrl}`);
    }
  } catch (error) {
    pairingRequested = false;
    setCurrentPairingCode('');
    console.error('[WhatsApp] Falha ao solicitar código de pareamento:', error.message);
  }
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

async function generateQrPng(value) {
  if (!value) return '';
  return QRCode.toDataURL(value, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });
}

async function connectWhatsApp(openCallback = null) {
  if (typeof openCallback === 'function') {
    onOpenCallback = openCallback;
  }

  if (connectInFlight) return sock;
  connectInFlight = true;
  clearReconnectTimer();
  disposeCurrentSocket();

  await resetAuthFolderIfNeeded();
  try {
    const { state, saveCreds } = await useMultiFileAuthState(config.whatsappAuthFolder);
    const { version } = await fetchLatestBaileysVersion();
    connectionState = 'connecting';

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      version,
      browser: getBrowserConfig(),
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid) => getCachedGroupMetadata(jid)
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'connecting' && canRequestPairingCode()) {
        setTimeout(() => {
          maybeRequestPairingCode('connecting').catch((error) => {
            console.error('[WhatsApp] Erro ao iniciar pareamento:', error.message);
          });
        }, 1500);
      }

      if (qr) {
        connectionState = 'qr';
        setCurrentQr(qr);
        try {
          currentQr.svg = await generateQrSvg(qr);
          currentQr.png = await generateQrPng(qr);
        } catch (error) {
          console.error('[WhatsApp] Falha ao gerar QR SVG:', error.message);
          currentQr.svg = '';
          currentQr.png = '';
        }
        const pairingPageUrl = getPairingPageUrl();
        if (pairingPageUrl) {
          console.log(`[WhatsApp] Abra o login do bot em: ${pairingPageUrl}`);
        }
        if (config.whatsappLoginMethod === 'qr') {
          console.log('[WhatsApp] Escaneie o QR Code na página /qr.');
          qrcode.generate(qr, { small: true });
        }
        if (canRequestPairingCode()) {
          startPairingRefreshTimer();
          setTimeout(() => {
            maybeRequestPairingCode('qr-event').catch((error) => {
              console.error('[WhatsApp] Erro ao iniciar pareamento:', error.message);
            });
          }, 2500);
        }
      }

      if (connection === 'open') {
        connectionState = 'open';
        reconnectAttempts = 0;
        pairingRequested = false;
        lastPairingRequestAt = 0;
        getSocketIdentityId();
        setCurrentQr('');
        currentQr.svg = '';
        currentQr.png = '';
        setCurrentPairingCode('');
        clearPairingRefreshTimer();
        clearReconnectTimer();
        console.log('[WhatsApp] Conectado com sucesso.');
        if (onOpenCallback) {
          await onOpenCallback().catch((error) => console.error('[WhatsApp] Erro ao iniciar agendadores após conexão:', error.message));
        }
      }

      if (connection === 'close') {
        connectionState = 'close';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = lastDisconnect?.error?.message || 'close';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('[WhatsApp] Conexão fechada.', `status=${statusCode || 'n/a'}.`, shouldReconnect ? 'Reconectando...' : 'Sessão encerrada.');
        if (lastDisconnect?.error) {
          console.error('[WhatsApp] Erro de desconexão:', lastDisconnect.error.message || lastDisconnect.error);
        }
        clearPairingRefreshTimer();
        pairingRequested = false;
        setCurrentPairingCode('');
        if (shouldReconnect) {
          scheduleReconnect(statusCode, disconnectReason);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        if (!msg.message || msg.key.fromMe) continue;
        await handleCommand(msg).catch((error) => console.error('[WhatsApp] Erro em comando:', error.message));
      }
    });

    sock.ev.on('groups.update', async (events = []) => {
      for (const event of events) {
        if (!event?.id) continue;
        try {
          const metadata = await sock.groupMetadata(event.id);
          setCachedGroupMetadata(event.id, metadata);
        } catch (error) {
          console.warn('[WhatsApp] Falha ao atualizar cache do grupo:', event.id, error.message);
        }
      }
    });

    sock.ev.on('group-participants.update', async (event) => {
      if (!event?.id) return;
      try {
        const metadata = await sock.groupMetadata(event.id);
        setCachedGroupMetadata(event.id, metadata);
      } catch (error) {
        console.warn('[WhatsApp] Falha ao atualizar cache de participantes:', event.id, error.message);
      }
    });

    return sock;
  } finally {
    connectInFlight = false;
  }
}

function getWhatsAppStatus() {
  return {
    connectionState,
    qr: currentQr.value,
    qrSvg: currentQr.svg,
    qrPng: currentQr.png,
    qrUpdatedAt: currentQr.updatedAt,
    pairingCode: currentPairingCode.value,
    pairingCodeUpdatedAt: currentPairingCode.updatedAt,
    loginMethod: config.whatsappLoginMethod,
    reconnectAttempts,
    pairingCooldownSeconds: lastPairingRequestAt
      ? Math.max(0, Math.ceil((PAIRING_REQUEST_COOLDOWN_MS - (Date.now() - lastPairingRequestAt)) / 1000))
      : 0
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
    await reply(jid, `Status: ${paused ? 'pausado' : 'ativo'}\nFila: ${stats.pending}\nProntas: ${stats.readyToPublish || 0}\nRevisão imagem: ${stats.pendingImageReview || 0}\nFalha imagem: ${stats.imageReviewFailed || 0}\nEnviadas: ${stats.sent}\nGrupo alvo: ${config.whatsappGroupId || 'não configurado'}`);
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
    const pending = loadQueue().filter((item) => item.status === 'ready_to_publish').slice(0, 5);
    if (!pending.length) {
      await reply(jid, 'Nenhuma oferta pronta para publicar. Use /coletar para buscar e revisar novas ofertas.');
      return;
    }
    await reply(jid, pending.map((offer, i) => `${i + 1}. ${offer.title}\n${offer.url}`).join('\n\n'));
    return;
  }

  if (command === '/coletar') {
    await reply(jid, 'Iniciando coleta agora...');
    const result = await runCollector();
    await reply(jid, `Coleta finalizada. Coletadas: ${result.collected}. Novas na fila: ${result.added}. Revisadas: ${result.review?.reviewed || 0}. Prontas: ${result.review?.ready || 0}. Pendentes: ${result.stats.pending}.`);
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
  const normalizedTargetJid = normalizeJid(targetJid);
  if (!normalizedTargetJid) {
    return { mode: 'error', reason: 'missing_group_id' };
  }
  if (!getSocketIdentityId()) {
    return { mode: 'error', reason: 'missing_whatsapp_identity' };
  }

  const caption = buildOfferMessage(offer);

  if (config.requireVerifiedImage && !offer.imageVerified && !config.allowUntrustedImageTesting) {
    return { mode: 'skipped_no_verified_image', reason: 'missing_verified_image' };
  }

  if (config.sendProductImage && (offer.imageBuffer || offer.imageUrl)) {
    try {
      if (offer.imageBuffer) {
        await sock.sendMessage(normalizedTargetJid, {
          image: offer.imageBuffer,
          caption,
          mimetype: offer.imageContentType || 'image/png'
        });
      } else {
        const imageUrl = String(offer.imageUrl || '').trim();
        if (!imageUrl) {
          throw new Error('missing_image_url');
        }
        const imageResponse = await axios.get(imageUrl, {
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

        await sock.sendMessage(normalizedTargetJid, {
          image: Buffer.from(imageResponse.data),
          caption,
          mimetype: imageResponse.headers?.['content-type'] || 'image/jpeg'
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

  await sock.sendMessage(normalizedTargetJid, { text: caption });
  return { mode: 'text' };
}

async function validateForPublish(offer) {
  if (!offer) return null;
  if (offer.status === 'ready_to_publish') return offer;
  if (!config.publishOnlyValidated) return offer;
  const result = await enrichAndValidateOffer(offer);
  if (!result?.ok) {
    markImageReviewFailed(offer, result || { reason: 'validation_failed' });
    return null;
  }
  return result.offer;
}

async function sendOfferDirect(targetJid, offer) {
  if (!sock) return { sent: false, reason: 'whatsapp_not_connected' };
  if (!targetJid) return { sent: false, reason: 'missing_group_id' };
  if (!getSocketIdentityId()) return { sent: false, reason: 'missing_whatsapp_identity' };
  const normalizedOffer = await validateForPublish(offer);
  if (!normalizedOffer) return { sent: false, reason: 'validation_failed' };
  const result = await sendOffer(targetJid, normalizedOffer);
  if (result.mode === 'error' || result.mode === 'skipped_no_verified_image') {
    return { sent: false, ...result };
  }
  return { sent: true, ...result };
}

async function publishNextOffers(limit = config.maxPostsPerRun, overrideJid = null, sourceUrl = null) {
  if (!sock) return { sent: 0, reason: 'whatsapp_not_connected' };
  if (paused && !overrideJid) return { sent: 0, reason: 'paused' };
  if (!getSocketIdentityId()) return { sent: 0, reason: 'missing_whatsapp_identity' };

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
        console.log(`[Publisher] Oferta mantida para revisão de imagem: ${offer.title}`);
        continue;
      }

      const result = await sendOffer(targetJid, normalizedOffer);
      const persistedOffer = { ...normalizedOffer };
      delete persistedOffer.imageBuffer;
      delete persistedOffer.imageContentType;
      if (result.mode === 'skipped_no_verified_image') {
        markImageReviewFailed(persistedOffer, result);
        console.log(`[Publisher] Oferta voltou para revisão por falta de imagem verificada: ${normalizedOffer.title}`);
        continue;
      }

      markSent(persistedOffer, result);
      sent += 1;
      console.log(`[Publisher] Oferta enviada: ${normalizedOffer.title}`);
    } catch (error) {
      console.error('[Publisher] Falha ao enviar oferta:', error.stack || error.message);
    }
  }

  return { sent };
}

process.on('exit', () => {
  closePlaywrightBrowser().catch(() => {});
});

module.exports = { connectWhatsApp, publishNextOffers, sendOfferDirect, getWhatsAppStatus, waitForWhatsAppReady };
