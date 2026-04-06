'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');

// =========================
// AYARLAR
// =========================
const ALLOWED_USERS = [
  '905542812424@s.whatsapp.net',
  '905529201746@s.whatsapp.net',
];

const API_BASE_URL = 'https://parkevler2sitesi.com.tr/api.php';
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const PORT = 8080;
const PUBLIC_IP = '16.170.215.163';

// =========================
// GLOBAL STATE
// =========================
let sock = null;
let currentQR = null;
let botConnected = false;
let reconnectTimer = null;
let isStarting = false;
const sessions = {};

// =========================
// YARDIMCI FONKSİYONLAR
// =========================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function cleanJid(jid = '') {
  return String(jid || '').trim();
}

function extractNumericId(jid = '') {
  return cleanJid(jid).replace(/@.*$/, '');
}

function isPhoneJid(jid = '') {
  return /@s\.whatsapp\.net$/.test(cleanJid(jid));
}

function formatTL(amount) {
  return (
    parseFloat(amount || 0).toLocaleString('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' ₺'
  );
}

function normalizeDaireNo(input) {
  if (!input) return null;

  const raw = String(input)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '');

  const match = raw.match(/^([AB])(\d{1,2})$/);
  if (!match) return null;

  const blok = match[1];
  const no = parseInt(match[2], 10);

  if (blok === 'A' && no >= 1 && no <= 10) return `A${no}`;
  if (blok === 'B' && no >= 1 && no <= 60) return `B${no}`;

  return null;
}

function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  ).trim();
}

function getPossibleSenderJids(msg) {
  return [
    msg?.key?.participant,
    msg?.participant,
    msg?.sender,
    msg?.key?.remoteJid,
    msg?.pushName,
  ]
    .filter(Boolean)
    .map(cleanJid);
}

function isYetkiliFromMsg(msg) {
  const remoteJid = cleanJid(msg?.key?.remoteJid || '');

  // Grup mesajlarına cevap verme
  if (!remoteJid || remoteJid.endsWith('@g.us')) {
    return { ok: false, matched: null, reason: 'group-or-empty' };
  }

  const allowedNumbers = ALLOWED_USERS.map(u => extractNumericId(u));
  const candidates = getPossibleSenderJids(msg);

  // Önce telefon formatlı JID ara
  const phoneCandidate = candidates.find(jid => isPhoneJid(jid));

  if (phoneCandidate) {
    const senderNumber = extractNumericId(phoneCandidate);

    if (allowedNumbers.includes(senderNumber)) {
      return { ok: true, matched: phoneCandidate, reason: 'direct-match' };
    }

    return { ok: false, matched: phoneCandidate, reason: 'no-match' };
  }

  // Telefon formatlı JID yoksa reddet
  return { ok: false, matched: remoteJid, reason: 'not-phone-jid' };
}

// =========================
// METİNLER
// =========================
function menuText() {
  return (
    '👋 *Parkevler2 Aidat Bilgi Servisi*\n\n' +
    'Daire numaranızı yazarak ödenmemiş borçlarınızı sorgulayabilirsiniz.\n\n' +
    '✅ Geçerli daireler:\n' +
    '• A1 - A10\n' +
    '• B1 - B60\n\n' +
    '➡️ Lütfen *daire numaranızı* yazın:\n' +
    '_Örnek: A1, a5, B12, b60_'
  );
}

function formatBorcMesaji(daireNo, faturalar) {
  if (!faturalar || faturalar.length === 0) {
    return `✅ *Daire ${daireNo}*\n\nÖdenmemiş borcunuz bulunmamaktadır. 🎉`;
  }

  let toplam = 0;
  let satirlar = '';

  faturalar.forEach((f, i) => {
    const tutar = parseFloat(f.amount || 0);
    toplam += tutar;

    satirlar += `\n${i + 1}. *${f.period || '-'}* — ${f.category || '-'}\n`;

    if (f.description) {
      satirlar += `   📝 ${f.description}\n`;
    }

    satirlar += `   💰 ${formatTL(tutar)}\n`;
  });

  return (
    `🏠 *Daire ${daireNo} — Borç Özeti*\n` +
    `━━━━━━━━━━━━━━━━━━━━` +
    satirlar +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Toplam: *${formatTL(toplam)}*\n\n` +
    `_Ödeme için yönetici ile iletişime geçiniz._`
  );
}

// =========================
// API
// =========================
async function getBorclar(daireNo) {
  try {
    const response = await axios.get(API_BASE_URL, {
      params: {
        action: 'payment-filter',
        daireno: daireNo,
        status: 'odenmedi',
      },
      timeout: 15000,
    });

    const data = response.data;

    if (Array.isArray(data)) {
      return { success: true, data };
    }

    if (data?.status === 'error') {
      return {
        success: false,
        message: data.message || 'Bilinmeyen hata.',
      };
    }

    return {
      success: false,
      message: 'API geçersiz yanıt döndürdü.',
    };
  } catch (err) {
    log('API hatası: ' + err.message);
    return {
      success: false,
      message: 'Sunucuya bağlanılamadı. Lütfen daha sonra tekrar deneyin.',
    };
  }
}

// =========================
// HTTP SUNUCUSU
// =========================
http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (botConnected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff4">
            <h2 style="color:green">✅ Bot zaten bağlı!</h2>
            <p>WhatsApp bağlantısı aktif.</p>
          </body>
        </html>
      `);
      return;
    }

    if (currentQR) {
      try {
        const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f9f9f9">
              <h2>📱 Parkevler2 WhatsApp Bot</h2>
              <p>WhatsApp → <b>Bağlı Cihazlar</b> → <b>Cihaz Ekle</b> → Bu kodu okutun</p>
              <div style="display:inline-block;padding:16px;background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
                <img src="${qrImage}" style="display:block" />
              </div>
              <p style="color:#aaa;font-size:13px;margin-top:16px">Kod 20 saniyede yenilenir</p>
              <script>setTimeout(()=>location.reload(),20000)</script>
            </body>
          </html>
        `);
      } catch (e) {
        res.writeHead(500);
        res.end('QR oluşturulamadı: ' + e.message);
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
          <h3>⏳ QR hazırlanıyor...</h3>
          <p>10 saniye bekleyin.</p>
          <script>setTimeout(()=>location.reload(),10000)</script>
        </body>
      </html>
    `);
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      botConnected,
      hasQR: !!currentQR,
      allowedUsers: ALLOWED_USERS,
      time: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(botConnected ? 'Bot aktif ve bagli' : 'Bot baslatiliyor... QR icin /qr adresine gidin');
}).listen(PORT, '0.0.0.0', () => {
  log(`🚀 HTTP sunucu başladı → http://${PUBLIC_IP}:${PORT}`);
  log(`🔗 QR sayfası         → http://${PUBLIC_IP}:${PORT}/qr`);
  log(`💚 Health check       → http://${PUBLIC_IP}:${PORT}/health`);
});

// =========================
// MESAJ İŞLEME
// =========================
async function handleMessage(sock, msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return;

  if (jid.endsWith('@g.us')) return;

  const authCheck = isYetkiliFromMsg(msg);

  if (!authCheck.ok) {
    log(
      `⛔ Yetkisiz kullanıcı: remoteJid=${jid} candidates=${JSON.stringify(getPossibleSenderJids(msg))} reason=${authCheck.reason}`
    );
    return;
  }

  const text = getMessageText(msg);
  if (!text) return;

  log(`📨 Mesaj [${jid}] [user=${authCheck.matched}]: ${text}`);

  const textLower = text.toLowerCase();
  const MENU_KEYWORDS = [
    'merhaba',
    'selam',
    'hi',
    'hey',
    'başla',
    'basla',
    'menu',
    'menü',
    'yardım',
    'yardim',
    'help',
  ];

  if (MENU_KEYWORDS.includes(textLower) || !sessions[jid]) {
    sessions[jid] = { step: 'bekle_daire_no' };
    await sock.sendMessage(jid, { text: menuText() });
    return;
  }

  const session = sessions[jid];

  if (session.step === 'bekle_daire_no') {
    const daireNo = normalizeDaireNo(text);

    if (!daireNo) {
      await sock.sendMessage(jid, {
        text:
          '❌ Geçersiz daire numarası.\n\n' +
          'Sadece şu daireler geçerlidir:\n' +
          '• A1 - A10\n' +
          '• B1 - B60\n\n' +
          'Lütfen tekrar yazın.\n' +
          '_Örnek: A1, a5, B12, b60_',
      });
      return;
    }

    await sock.sendMessage(jid, {
      text: `🔍 *${daireNo}* nolu daire sorgulanıyor...`,
    });

    const result = await getBorclar(daireNo);

    if (!result.success) {
      await sock.sendMessage(jid, {
        text:
          `❌ Hata: ${result.message}\n\n` +
          'Tekrar sorgulamak için geçerli bir daire numarası yazın.',
      });
      return;
    }

    await sock.sendMessage(jid, {
      text: formatBorcMesaji(daireNo, result.data),
    });

    await sock.sendMessage(jid, {
      text:
        '🔄 Başka bir daire sorgulamak için daire numarasını yazın.\n' +
        '⬅️ Ana menü için *menü* yazın.',
    });
  }
}

// =========================
// BOT BAŞLATMA
// =========================
async function startBot() {
  if (isStarting) {
    log('Bot zaten başlatılıyor, atlandı.');
    return;
  }

  isStarting = true;

  try {
    ensureDir(AUTH_FOLDER);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    log(`Baileys version: ${version.join('.')}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: 'silent' })
        ),
      },
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 5,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        botConnected = false;

        log('📱 QR HAZIR');
        log(`🌐 Web QR: http://${PUBLIC_IP}:${PORT}/qr`);
        log('📲 Terminal QR aşağıda:');
        console.log('');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('');
      }

      if (connection === 'open') {
        botConnected = true;
        currentQR = null;
        log('✅ WhatsApp bağlantısı kuruldu! Bot aktif.');
      }

      if (connection === 'close') {
        botConnected = false;

        const code = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = code === DisconnectReason.loggedOut;
        const isBadSession = code === DisconnectReason.badSession;

        log(`❌ Bağlantı kapandı. Kod: ${code}`);

        if (isLoggedOut || isBadSession) {
          log('⚠️ Oturum geçersiz. Auth klasörü siliniyor, yeniden QR gerekiyor...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          currentQR = null;
        }

        scheduleReconnect(isLoggedOut || isBadSession ? 2000 : 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg?.key?.fromMe) continue;

        try {
          await handleMessage(sock, msg);
        } catch (err) {
          log('Mesaj işleme hatası: ' + err.message);
        }
      }
    });

  } catch (err) {
    botConnected = false;
    log('startBot hatası: ' + err.message);
    scheduleReconnect(10000);
  } finally {
    isStarting = false;
  }
}

function scheduleReconnect(delay = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(() => {
    log(`🔄 Yeniden bağlanılıyor... (${delay}ms sonra)`);
    startBot().catch(e => log('Reconnect hatası: ' + e.message));
  }, delay);
}

log('🚀 BOT BAŞLIYOR...');
log('🌐 SUNUCU CALISIYOR');
log(`📁 Auth klasoru: ${AUTH_FOLDER}`);
log(`🔗 QR: http://${PUBLIC_IP}:${PORT}/qr`);
startBot();

process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + err.message);
});

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection: ' + reason);
});
