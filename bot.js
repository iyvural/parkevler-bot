const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

// Sadece rakam olarak tutuyoruz
const ALLOWED_PHONES = [
  '905542812424',
  '905529201746',
];

const API_BASE_URL = 'https://parkevler2sitesi.com.tr/api.php';
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const PORT = process.env.PORT || 8080;
const PUBLIC_IP = process.env.PUBLIC_IP || '16.170.215.163';

// =========================
// GLOBAL
// =========================
let currentQR = null;
let botConnected = false;
let reconnectTimeout = null;
let isStarting = false;
let sockRef = null;
const sessions = {};

// =========================
// HELPER
// =========================
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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

function extractDigits(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits || null;
}

function jidToPhone(jid) {
  if (!jid) return null;

  // 9055xxxxxxx@s.whatsapp.net
  const direct = jid.match(/^(\d{10,15})@/);
  if (direct) return direct[1];

  // 27651033026731@lid -> gerçek telefon değil
  // burada null dönüyoruz
  return null;
}

function getSenderCandidates(msg) {
  const candidates = new Set();

  const remoteJid = msg?.key?.remoteJid || null;
  const participant = msg?.key?.participant || null;
  const participantPn = msg?.message?.extendedTextMessage?.contextInfo?.participant || null;
  const pushName = msg?.pushName || null;

  [remoteJid, participant, participantPn].forEach((v) => {
    if (v) candidates.add(v);
  });

  const phoneCandidates = [];

  for (const c of candidates) {
    const phone = jidToPhone(c);
    if (phone) phoneCandidates.push(phone);
  }

  // Bazen pushName içinde numara olabilir, yine de deneyelim
  const pushDigits = extractDigits(pushName);
  if (pushDigits && pushDigits.length >= 10) {
    phoneCandidates.push(pushDigits);
  }

  return {
    remoteJid,
    rawCandidates: Array.from(candidates),
    phoneCandidates: [...new Set(phoneCandidates)],
  };
}

function isYetkiliUser(msg) {
  const info = getSenderCandidates(msg);
  const matchedPhone = info.phoneCandidates.find((p) => ALLOWED_PHONES.includes(p));

  return {
    allowed: !!matchedPhone,
    matchedPhone: matchedPhone || null,
    info,
  };
}

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
    if (f.description) satirlar += `   📝 ${f.description}\n`;
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

    if (data && data.status === 'error') {
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
    console.error('API hatasi:', err?.message || err);
    return {
      success: false,
      message: 'Sunucuya bağlanılamadı. Lütfen daha sonra tekrar deneyin.',
    };
  }
}

// =========================
// HTTP SERVER
// =========================
http
  .createServer(async (req, res) => {
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
                <p style="color:#555">
                  WhatsApp → <b>Bağlı Cihazlar</b> → <b>Cihaz Ekle</b> → Bu kodu okutun
                </p>
                <div style="display:inline-block;padding:16px;background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
                  <img src="${qrImage}" style="display:block" />
                </div>
                <p style="color:#aaa;font-size:13px;margin-top:16px">
                  Kod kısa sürede yenilenebilir — sayfa otomatik yenilenir
                </p>
                <script>
                  setTimeout(() => location.reload(), 20000)
                </script>
              </body>
            </html>
          `);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
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
            <script>
              setTimeout(() => location.reload(), 10000)
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          botConnected,
          hasQR: !!currentQR,
          authFolder: AUTH_FOLDER,
          time: new Date().toISOString(),
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(botConnected ? 'Bot aktif ve bagli' : 'Bot baslatiliyor... QR icin /qr adresine gidin');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log('🚀 BOT BASLIYOR...');
    console.log('🌐 SUNUCU CALISIYOR');
    console.log('📁 Auth klasoru:', AUTH_FOLDER);
    console.log(`🔗 QR: http://${PUBLIC_IP}:${PORT}/qr`);
  });

// =========================
// MESAJ İŞLEME
// =========================
async function handleMessage(sock, msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return;

  if (jid.endsWith('@g.us')) return;

  const auth = isYetkiliUser(msg);
  if (!auth.allowed) {
    console.log(
      `[${new Date().toISOString()}] ⛔ Yetkisiz kullanıcı: remoteJid=${auth.info.remoteJid} candidates=${JSON.stringify(auth.info.rawCandidates)} phones=${JSON.stringify(auth.info.phoneCandidates)}`
    );
    return;
  }

  const text = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  ).trim();

  if (!text) return;

  const textLower = text.toLowerCase();

  if (
    ['merhaba', 'selam', 'hi', 'hey', 'başla', 'basla', 'menu', 'menü', 'yardım', 'yardim', 'help'].includes(textLower)
  ) {
    sessions[jid] = { step: 'bekle_daire_no' };
    await sock.sendMessage(jid, { text: menuText() });
    return;
  }

  if (!sessions[jid]) {
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
      sessions[jid] = { step: 'bekle_daire_no' };
      return;
    }

    await sock.sendMessage(jid, {
      text: `🔍 *${daireNo}* nolu daire sorgulanıyor...`,
    });

    const result = await getBorclar(daireNo);

    if (!result.success) {
      await sock.sendMessage(jid, {
        text:
          '❌ Hata: ' +
          result.message +
          '\n\nTekrar sorgulamak için geçerli bir daire numarası yazın.',
      });
      sessions[jid] = { step: 'bekle_daire_no' };
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

    sessions[jid] = { step: 'bekle_daire_no' };
  }
}

// =========================
// BOT BAŞLATMA
// =========================
async function startBot() {
  if (isStarting) {
    console.log('Bot zaten baslatiliyor, tekrar deneme atlandi.');
    return;
  }

  isStarting = true;

  try {
    ensureDir(AUTH_FOLDER);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sockRef = sock;

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        botConnected = false;

        console.log('\n📱 QR HAZIR');
        console.log(`🌐 Web QR: http://${PUBLIC_IP}:${PORT}/qr`);
        console.log('📲 Terminal QR aşağıda:\n');
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        botConnected = true;
        currentQR = null;
        console.log('✅ WhatsApp baglantisi kuruldu! Bot aktif.');
      }

      if (connection === 'close') {
        botConnected = false;
        sockRef = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log('❌ Baglanti kapandi. Kod:', statusCode, 'Reconnect:', shouldReconnect);

        if (shouldReconnect) {
          if (reconnectTimeout) clearTimeout(reconnectTimeout);

          reconnectTimeout = setTimeout(() => {
            console.log('🔄 Bot yeniden baglanmayi deniyor...');
            startBot().catch((err) => {
              console.error('Reconnect hatasi:', err);
            });
          }, 5000);
        } else {
          currentQR = null;
          console.log('⚠️ Oturum logout oldu. Yeniden QR okutulmasi gerekir.');
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg?.key?.fromMe) {
          try {
            await handleMessage(sock, msg);
          } catch (err) {
            console.error('Mesaj isleme hatasi:', err);
          }
        }
      }
    });
  } catch (err) {
    botConnected = false;
    sockRef = null;
    console.error('startBot hatasi:', err);

    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    reconnectTimeout = setTimeout(() => {
      console.log('Hata sonrasi yeniden baslatma deneniyor...');
      startBot().catch((e) => console.error('Tekrar baslatma hatasi:', e));
    }, 10000);
  } finally {
    isStarting = false;
  }
}

startBot();

// =========================
// HATA YAKALAMA
// =========================
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
  const match = raw.match(/^([AB])(\d{1,2})$/);
  if (!match) return null;

  const blok = match[1];
  const no = parseInt(match[2], 10);

  if (blok === 'A' && no >= 1 && no <= 10) return `A${no}`;
  if (blok === 'B' && no >= 1 && no <= 60) return `B${no}`;

  return null;
}

function isYetkiliUser(jid) {
  return ALLOWED_USERS.includes(jid);
}

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
    if (f.description) satirlar += `   📝 ${f.description}\n`;
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

    if (data && data.status === 'error') {
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
    return {
      success: false,
      message: 'Sunucuya bağlanılamadı. Lütfen daha sonra tekrar deneyin.',
    };
  }
}

// =========================
// HTTP SERVER
// =========================
http
  .createServer(async (req, res) => {
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
                <p style="color:#555">
                  WhatsApp → <b>Bağlı Cihazlar</b> → <b>Cihaz Ekle</b> → Bu kodu okutun
                </p>
                <div style="display:inline-block;padding:16px;background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
                  <img src="${qrImage}" style="display:block" />
                </div>
                <p style="color:#aaa;font-size:13px;margin-top:16px">
                  Kod kısa sürede yenilenebilir — sayfa otomatik yenilenir
                </p>
                <script>
                  setTimeout(() => location.reload(), 20000)
                </script>
              </body>
            </html>
          `);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
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
            <script>
              setTimeout(() => location.reload(), 10000)
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          botConnected,
          hasQR: !!currentQR,
          authFolder: AUTH_FOLDER,
          time: new Date().toISOString(),
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(botConnected ? 'Bot aktif ve bagli' : 'Bot baslatiliyor... QR icin /qr adresine gidin');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log('🚀 BOT BASLIYOR...');
    console.log('🌐 SUNUCU CALISIYOR');
    console.log('📁 Auth klasoru:', AUTH_FOLDER);
    console.log(`🔗 QR: http://${PUBLIC_IP}:${PORT}/qr`);
  });

// =========================
// MESAJ İŞLEME
// =========================
async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;

  if (jid.endsWith('@g.us')) return;
  if (!isYetkiliUser(jid)) return;

  const text =
    (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

  if (!text) return;

  const textLower = text.toLowerCase();

  if (
    ['merhaba', 'selam', 'hi', 'hey', 'başla', 'basla', 'menu', 'menü', 'yardım', 'yardim', 'help'].includes(textLower)
  ) {
    sessions[jid] = { step: 'bekle_daire_no' };
    await sock.sendMessage(jid, { text: menuText() });
    return;
  }

  if (!sessions[jid]) {
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
      sessions[jid] = { step: 'bekle_daire_no' };
      return;
    }

    await sock.sendMessage(jid, {
      text: `🔍 *${daireNo}* nolu daire sorgulanıyor...`,
    });

    const result = await getBorclar(daireNo);

    if (!result.success) {
      await sock.sendMessage(jid, {
        text:
          '❌ Hata: ' +
          result.message +
          '\n\nTekrar sorgulamak için geçerli bir daire numarası yazın.',
      });
      sessions[jid] = { step: 'bekle_daire_no' };
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

    sessions[jid] = { step: 'bekle_daire_no' };
  }
}

// =========================
// BOT BAŞLATMA
// =========================
async function startBot() {
  if (isStarting) {
    console.log('Bot zaten baslatiliyor, tekrar deneme atlandi.');
    return;
  }

  isStarting = true;

  try {
    ensureDir(AUTH_FOLDER);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        botConnected = false;

        console.log('\n📱 QR HAZIR');
        console.log(`🌐 Web QR: http://${PUBLIC_IP}:${PORT}/qr`);
        console.log('📲 Terminal QR aşağıda:\n');

        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        botConnected = true;
        currentQR = null;
        console.log('✅ WhatsApp baglantisi kuruldu! Bot aktif.');
      }

      if (connection === 'close') {
        botConnected = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log('❌ Baglanti kapandi. Kod:', statusCode, 'Reconnect:', shouldReconnect);

        if (shouldReconnect) {
          if (reconnectTimeout) clearTimeout(reconnectTimeout);

          reconnectTimeout = setTimeout(() => {
            console.log('🔄 Bot yeniden baglanmayi deniyor...');
            startBot().catch((err) => {
              console.error('Reconnect hatasi:', err);
            });
          }, 5000);
        } else {
          currentQR = null;
          console.log('⚠️ Oturum logout oldu. Yeniden QR okutulmasi gerekir.');
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.key.fromMe) {
          try {
            await handleMessage(sock, msg);
          } catch (err) {
            console.error('Mesaj isleme hatasi:', err);
          }
        }
      }
    });
  } catch (err) {
    botConnected = false;
    console.error('startBot hatasi:', err);

    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    reconnectTimeout = setTimeout(() => {
      console.log('Hata sonrasi yeniden baslatma deneniyor...');
      startBot().catch((e) => console.error('Tekrar baslatma hatasi:', e));
    }, 10000);
  } finally {
    isStarting = false;
  }
}

startBot();

// =========================
// HATA YAKALAMA
// =========================
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
