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

let currentQR = null;
let botConnected = false;

const API_BASE_URL = 'https://parkevler2sitesi.com.tr/api.php';

const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    if (req.url === '/qr') {
        if (botConnected) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff4"><h2 style="color:green">✅ Bot zaten bağlı!</h2><p>WhatsApp bağlantısı aktif.</p></body></html>');
        } else if (currentQR) {
            try {
                const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f9f9f9"><h2>📱 Parkevler2 WhatsApp Bot</h2><p style="color:#555">WhatsApp → <b>Bağlı Cihazlar</b> → <b>Cihaz Ekle</b> → Bu kodu okutun</p><div style="display:inline-block;padding:16px;background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)"><img src="${qrImage}" style="display:block"/></div><p style="color:#aaa;font-size:13px;margin-top:16px">Kod 60 saniyede yenilenir — sayfa otomatik yenilenir</p><script>setTimeout(()=>location.reload(), 25000)</script></body></html>`);
            } catch (e) {
                res.writeHead(500);
                res.end('QR olusturulamadi: ' + e.message);
            }
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>⏳ QR hazırlanıyor...</h3><p>10 saniye bekleyin.</p><script>setTimeout(()=>location.reload(), 10000)</script></body></html>');
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(botConnected ? 'Bot aktif ve bagli' : 'Bot baslatiliyor... QR icin /qr adresine gidin');
    }
}).listen(PORT, () => {
    console.log('Sunucu port ' + PORT + ' uzerinde calisiyor');
});

const sessions = {};

function formatTL(amount) {
    return parseFloat(amount).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
}

async function getBorclar(daireNo) {
    try {
        const response = await axios.get(API_BASE_URL, {
            params: { action: 'payment-filter', daireno: daireNo, status: 'odenmedi' },
            timeout: 10000
        });
        const data = response.data;
        if (Array.isArray(data)) return { success: true, data };
        if (data && data.status === 'error') return { success: false, message: data.message || 'Bilinmeyen hata.' };
        return { success: false, message: 'API gecersiz yanit dondurdu.' };
    } catch (err) {
        return { success: false, message: 'Sunucuya baglanılamadı. Lütfen daha sonra tekrar deneyin.' };
    }
}

function formatBorcMesaji(daireNo, faturalar) {
    if (!faturalar || faturalar.length === 0) {
        return '✅ *Daire ' + daireNo + '*\n\nÖdenmemiş borcunuz bulunmamaktadır. 🎉';
    }
    let toplam = 0;
    let satirlar = '';
    faturalar.forEach((f, i) => {
        const tutar = parseFloat(f.amount || 0);
        toplam += tutar;
        satirlar += '\n' + (i+1) + '. *' + (f.period||'-') + '* — ' + (f.category||'-') + '\n';
        if (f.description) satirlar += '   📝 ' + f.description + '\n';
        satirlar += '   💰 ' + formatTL(tutar) + '\n';
    });
    return '🏠 *Daire ' + daireNo + ' — Borç Özeti*\n━━━━━━━━━━━━━━━━━━━━' + satirlar + '━━━━━━━━━━━━━━━━━━━━\n📋 Toplam: *' + formatTL(toplam) + '*\n\n_Ödeme için yönetici ile iletişime geçiniz._';
}

async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    if (jid.endsWith('@g.us')) return;
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!text) return;
    const textLower = text.toLowerCase();

    if (['merhaba','selam','hi','hey','başla','menu','menü','yardım','help'].includes(textLower)) {
        sessions[jid] = { step: 'bekle_daire_no' };
        await sock.sendMessage(jid, { text: '👋 *Parkevler2 Aidat Bilgi Servisi*\n\nDaire numaranızı yazarak ödenmemiş borçlarınızı sorgulayabilirsiniz.\n\n➡️ Lütfen *daire numaranızı* yazın:\n_(Örnek: 12 veya A-5)_' });
        return;
    }
    if (!sessions[jid]) {
        sessions[jid] = { step: 'bekle_daire_no' };
        await sock.sendMessage(jid, { text: '🏢 *Parkevler2 Borç Sorgulama*\n\nDaire numaranızı yazın, ödenmemiş borçlarınızı görelim:\n_(Örnek: 12 veya A-5)_' });
        return;
    }
    const session = sessions[jid];
    if (session.step === 'bekle_daire_no') {
        const daireNo = text;
        await sock.sendMessage(jid, { text: '🔍 *' + daireNo + '* nolu daire sorgulanıyor...' });
        const result = await getBorclar(daireNo);
        if (!result.success) {
            await sock.sendMessage(jid, { text: '❌ Hata: ' + result.message + '\n\nTekrar sorgulamak için daire numaranızı yazın.' });
            sessions[jid] = { step: 'bekle_daire_no' };
            return;
        }
        await sock.sendMessage(jid, { text: formatBorcMesaji(daireNo, result.data) });
        await sock.sendMessage(jid, { text: '🔄 Başka bir daire sorgulamak için daire numarasını yazın.\n⬅️ Ana menü için *menü* yazın.' });
        session.step = 'bekle_daire_no';
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger: pino({ level: 'silent' }), auth: state, printQRInTerminal: false });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            botConnected = false;
            console.log('QR hazir! Railway URL adresinize /qr ekleyin ve tarayicidan acin.');
        }
        if (connection === 'close') {
            botConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            botConnected = true;
            currentQR = null;
            console.log('WhatsApp baglantisi kuruldu! Bot aktif.');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.key.fromMe) {
                try { await handleMessage(sock, msg); }
                catch (err) { console.error('Hata:', err); }
            }
        }
    });
}

console.log('Parkevler2 WhatsApp Bot baslatiliyor...');
startBot();
