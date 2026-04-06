const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const http = require('http');

// Railway / Render gibi platformların portu kapatmaması için basit HTTP sunucusu
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Parkevler2 WhatsApp Bot aktif ✅');
}).listen(PORT, () => {
    console.log(`🌐 Keep-alive sunucusu port ${PORT} üzerinde çalışıyor`);
});

// ============================================================
//  AYARLAR — kendi bilgilerinize göre değiştirin
// ============================================================
const API_BASE_URL = 'https://parkevler2sitesi.com.tr/api.php'; // <-- kendi alan adınız
// ============================================================

// Kullanıcı oturumlarını bellekte tut (daire no bekleniyor mu?)
const sessions = {};

// Türkçe para formatı
function formatTL(amount) {
    return parseFloat(amount).toLocaleString('tr-TR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }) + ' ₺';
}

// API'den ödenmemiş faturaları çek
async function getBorclar(daireNo) {
    try {
        const response = await axios.get(API_BASE_URL, {
            params: {
                action: 'payment-filter',
                daireno: daireNo,
                status: 'odenmedi'
            },
            timeout: 10000
        });

        const data = response.data;

        // Dizi döndüyse direkt kullan
        if (Array.isArray(data)) {
            return { success: true, data };
        }

        // Hata objesi döndüyse
        if (data && data.status === 'error') {
            return { success: false, message: data.message || 'Bilinmeyen hata.' };
        }

        return { success: false, message: 'API geçersiz yanıt döndürdü.' };

    } catch (err) {
        console.error('API hatası:', err.message);
        return { success: false, message: 'Sunucuya bağlanılamadı. Lütfen daha sonra tekrar deneyin.' };
    }
}

// Borç mesajını formatla
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
        `📋 Toplam: *${formatTL(toplam)}*\n` +
        `\n_Ödeme için yönetici ile iletişime geçiniz._`
    );
}

// Gelen mesajı işle
async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;

    // Grup mesajlarını yoksay
    if (jid.endsWith('@g.us')) return;

    const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
    ).trim();

    if (!text) return;

    const textLower = text.toLowerCase();

    // Yardım / selamlama
    if (['merhaba', 'selam', 'hi', 'hey', 'başla', 'menu', 'menü', 'yardım', 'help'].includes(textLower)) {
        sessions[jid] = { step: 'bekle_daire_no' };
        await sock.sendMessage(jid, {
            text:
                `👋 *Parkevler2 Aidat Bilgi Servisi*\n\n` +
                `Daire numaranızı yazarak ödenmemiş borçlarınızı sorgulayabilirsiniz.\n\n` +
                `➡️ Lütfen *daire numaranızı* yazın:\n_(Örnek: 12 veya A-5)_`
        });
        return;
    }

    // Aktif oturum yoksa yönlendir
    if (!sessions[jid]) {
        sessions[jid] = { step: 'bekle_daire_no' };
        await sock.sendMessage(jid, {
            text:
                `🏢 *Parkevler2 Borç Sorgulama*\n\n` +
                `Daire numaranızı yazın, ödenmemiş borçlarınızı görelim:\n_(Örnek: 12 veya A-5)_`
        });
        return;
    }

    const session = sessions[jid];

    // Daire no bekleniyor
    if (session.step === 'bekle_daire_no') {
        const daireNo = text;

        await sock.sendMessage(jid, {
            text: `🔍 *${daireNo}* nolu daire sorgulanıyor...`
        });

        const result = await getBorclar(daireNo);

        if (!result.success) {
            await sock.sendMessage(jid, {
                text: `❌ Hata: ${result.message}\n\nTekrar sorgulamak için daire numaranızı yazın.`
            });
            sessions[jid] = { step: 'bekle_daire_no' };
            return;
        }

        const mesaj = formatBorcMesaji(daireNo, result.data);
        await sock.sendMessage(jid, { text: mesaj });

        // Başka sorgu yapabilsin
        await sock.sendMessage(jid, {
            text: `\n🔄 Başka bir daire sorgulamak için daire numarasını yazın.\n⬅️ Ana menü için *menü* yazın.`
        });

        session.step = 'bekle_daire_no'; // tekrar sorgu yapabilir
        return;
    }
}

// WhatsApp bağlantısını başlat
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // 'debug' yaparsanız detaylı log görürsünüz
        auth: state,
        printQRInTerminal: false,
    });

    // QR kodu terminale bas
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 WhatsApp\'a bağlanmak için QR kodu telefonunuzla okutun:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Bağlantı kesildi. Yeniden bağlanılıyor:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp bağlantısı kuruldu! Bot aktif.\n');
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
                    console.error('Mesaj işleme hatası:', err);
                }
            }
        }
    });
}

console.log('🚀 Parkevler2 WhatsApp Bot başlatılıyor...');
startBot();
