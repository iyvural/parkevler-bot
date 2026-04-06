const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode');
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

// =========================
// GLOBAL
// =========================
let currentQR = null;
let botConnected = false;

// =========================
// HELPER
// =========================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isYetkiliUser(jid) {
  return ALLOWED_USERS.includes(jid);
}

// =========================
// HTTP SERVER
// =========================
http.createServer(async (req, res) => {

  if (req.url === '/qr') {
    if (botConnected) {
      res.end('<h2>✅ Bot zaten bağlı</h2>');
      return;
    }

    if (!currentQR) {
      res.end('<h3>QR hazırlanıyor... 5sn bekle</h3>');
      return;
    }

    const qr = await QRCode.toDataURL(currentQR);

    res.end(`
      <html>
        <body style="text-align:center;font-family:sans-serif">
          <h2>QR OKUT</h2>
          <img src="${qr}" />
          <script>setTimeout(()=>location.reload(),10000)</script>
        </body>
      </html>
    `);
    return;
  }

  res.end('Bot calisiyor');

}).listen(PORT, '0.0.0.0', () => {
  console.log('🚀 SUNUCU CALISIYOR');
  console.log(`👉 QR: http://SUNUCU_IP:${PORT}/qr`);
});

// =========================
// BOT
// =========================
async function startBot() {
  ensureDir(AUTH_FOLDER);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📱 QR HAZIR → /qr aç');
    }

    if (connection === 'open') {
      botConnected = true;
      currentQR = null;
      console.log('✅ WHATSAPP BAGLANDI');
    }

    if (connection === 'close') {
      botConnected = false;
      console.log('❌ BAGLANTI KOPTU → yeniden deniyor');
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;

    if (jid.endsWith('@g.us')) return;
    if (!isYetkiliUser(jid)) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!text) return;

    await sock.sendMessage(jid, {
      text: '✅ Mesaj alındı',
    });
  });
}

console.log('🔥 BOT BASLIYOR...');
startBot();
