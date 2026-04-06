require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const http = require('http');

let currentQR = null;
let botConnected = false;
let didWarnMissingAllowedUsers = false;
const lidToPhoneMap = new Map();

const API_BASE_URL = process.env.API_BASE_URL || 'https://parkevler2sitesi.com.tr/api.php';
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_USERS = parseAllowedUsers(process.env.ALLOWED_USERS || '');

http.createServer(async (req, res) => {
    if (req.url === '/qr') {
        if (botConnected) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff4"><h2 style="color:green">Bot zaten bagli</h2><p>WhatsApp baglantisi aktif.</p></body></html>');
            return;
        }

        if (currentQR) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('QR terminal uzerinde uretiliyor. Sunucu konsolundaki karekodu WhatsApp ile taratin.');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>QR hazirlaniyor...</h3><p>10 saniye sonra sayfa yenilenecek.</p><script>setTimeout(()=>location.reload(), 10000)</script></body></html>');
        return;
    }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            botConnected,
            hasQR: Boolean(currentQR),
            time: new Date().toISOString(),
        }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(botConnected ? 'Bot aktif ve bagli' : 'Bot baslatiliyor. QR icin /qr adresine gidin');
}).listen(PORT, () => {
    console.log(`Sunucu port ${PORT} uzerinde calisiyor`);
});

function parseAllowedUsers(rawValue) {
    return new Set(
        rawValue
            .split(',')
            .map((value) => normalizePhone(value))
            .filter(Boolean)
    );
}

function normalizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) {
        return '';
    }

    if (digits.startsWith('00')) {
        return digits.slice(2);
    }

    return digits;
}

function getPhoneVariants(value) {
    const normalized = normalizePhone(value);
    if (!normalized) {
        return [];
    }

    const variants = new Set([normalized]);

    if (normalized.startsWith('0') && normalized.length === 11) {
        variants.add(`90${normalized.slice(1)}`);
    }

    if (normalized.startsWith('90') && normalized.length === 12) {
        variants.add(`0${normalized.slice(2)}`);
        variants.add(normalized.slice(2));
    }

    if (normalized.length >= 10) {
        variants.add(normalized.slice(-10));
    }

    return Array.from(variants);
}

function normalizeJidUser(jid) {
    return String(jid || '').split('@')[0];
}

function rememberPhoneMapping(lid, phoneJid) {
    const lidUser = normalizeJidUser(lid);
    const phoneUser = normalizeJidUser(phoneJid);
    const normalizedPhone = normalizePhone(phoneUser);

    if (!lidUser || !normalizedPhone) {
        return;
    }

    lidToPhoneMap.set(lidUser, normalizedPhone);
    console.log(`LID eslemesi kaydedildi: ${lidUser} -> ${normalizedPhone}`);
}

function extractCandidatePhones(msg) {
    const candidates = [
        msg?.key?.remoteJid,
        msg?.key?.participant,
        msg?.participant,
        msg?.senderPn,
        msg?.participantPn,
        msg?.pushName,
        msg?.message?.extendedTextMessage?.contextInfo?.participant,
        msg?.message?.extendedTextMessage?.contextInfo?.participantPn,
        msg?.message?.senderKeyDistributionMessage?.groupId,
    ];

    const phones = new Set();

    for (const candidate of candidates) {
        const raw = String(candidate || '');
        if (!raw) {
            continue;
        }

        if (raw.includes('@s.whatsapp.net')) {
            phones.add(raw.split('@')[0]);
            continue;
        }

        if (raw.includes('@lid')) {
            const mappedPhone = lidToPhoneMap.get(normalizeJidUser(raw));
            if (mappedPhone) {
                phones.add(mappedPhone);
            }
            continue;
        }

        const normalized = normalizePhone(raw);
        if (normalized.length >= 10 && normalized.length <= 15) {
            phones.add(normalized);
        }
    }

    return Array.from(phones);
}

function isAllowedUser(msg) {
    if (ALLOWED_USERS.size === 0) {
        if (!didWarnMissingAllowedUsers) {
            console.warn('UYARI: ALLOWED_USERS bos. Bot tum ozel mesajlari yanitlayacak.');
            didWarnMissingAllowedUsers = true;
        }
        return { allowed: true, matchedPhone: null, candidatePhones: [] };
    }

    const candidatePhones = extractCandidatePhones(msg);

    for (const senderPhone of candidatePhones) {
        const senderVariants = getPhoneVariants(senderPhone);

        for (const allowedUser of ALLOWED_USERS) {
            const allowedVariants = getPhoneVariants(allowedUser);
            if (allowedVariants.some((variant) => senderVariants.includes(variant))) {
                return { allowed: true, matchedPhone: senderPhone, candidatePhones };
            }
        }
    }

    return { allowed: false, matchedPhone: null, candidatePhones };
}

function normalizeApartmentInput(input) {
    const cleaned = String(input || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/-/g, '');

    const match = cleaned.match(/^([AB])(\d{1,2})$/);
    if (!match) {
        return null;
    }

    const block = match[1];
    const apartmentNumber = Number(match[2]);

    if (block === 'A' && apartmentNumber >= 1 && apartmentNumber <= 10) {
        return `A${apartmentNumber}`;
    }

    if (block === 'B' && apartmentNumber >= 1 && apartmentNumber <= 60) {
        return `B${apartmentNumber}`;
    }

    return null;
}

function formatTL(amount) {
    const numericAmount = Number(amount || 0);
    return numericAmount.toLocaleString('tr-TR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }) + ' TL';
}

async function getBorclar(daireNo) {
    try {
        const response = await axios.get(API_BASE_URL, {
            params: {
                action: 'payment-filter',
                daireno: daireNo,
                status: 'odenmedi',
            },
            timeout: 10000,
        });

        const data = response.data;

        if (Array.isArray(data)) {
            return { success: true, data };
        }

        if (data && data.status === 'error') {
            return { success: false, message: data.message || 'Bilinmeyen hata.' };
        }

        return { success: false, message: 'API gecersiz bir yanit dondurdu.' };
    } catch (error) {
        return { success: false, message: 'Sunucuya baglanilamadi. Lutfen daha sonra tekrar deneyin.' };
    }
}

function formatBorcMesaji(daireNo, faturalar) {
    if (!faturalar || faturalar.length === 0) {
        return `Daire ${daireNo}\n\nOdenmemis borc bulunmamaktadir.`;
    }

    let toplam = 0;
    let satirlar = '';

    faturalar.forEach((fatura, index) => {
        const tutar = Number(fatura.amount || 0);
        toplam += tutar;

        satirlar += `${index + 1}. ${fatura.period || '-'} - ${fatura.category || '-'}\n`;
        if (fatura.description) {
            satirlar += `Aciklama: ${fatura.description}\n`;
        }
        satirlar += `Tutar: ${formatTL(tutar)}\n\n`;
    });

    return `Daire ${daireNo} borc ozeti\n\n${satirlar}Toplam: ${formatTL(toplam)}\n\nOdeme icin yonetim ile iletisime gecebilirsiniz.`;
}

function getMessageText(message) {
    return (
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption ||
        ''
    ).trim();
}

function normalizeCommandText(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/\u00e7/g, 'c')
        .replace(/\u011f/g, 'g')
        .replace(/\u0131/g, 'i')
        .replace(/\u00f6/g, 'o')
        .replace(/\u015f/g, 's')
        .replace(/\u00fc/g, 'u');
}

function isHelpMessage(text) {
    const normalized = normalizeCommandText(text);
    return ['merhaba', 'selam', 'hi', 'hey', 'basla', 'menu', 'yardim', 'help'].includes(normalized);
}

function getHelpText() {
    return [
        'Parkevler2 borc sorgulama servisi',
        '',
        'Lutfen sadece daire kodunu gonderin.',
        'Gecerli ornekler: A1, A4, B12, B54',
        'Kucuk-buyuk harf fark etmez.',
        'Gecersiz kod ornekleri: 12, C4, A11, B61',
    ].join('\n');
}

async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@g.us')) {
        return;
    }

    const auth = isAllowedUser(msg);
    if (!auth.allowed) {
        console.log(`Izin verilmeyen numara engellendi: ${jid} phones=${JSON.stringify(auth.candidatePhones)}`);
        return;
    }

    if (auth.matchedPhone) {
        console.log(`Izinli kullanici eslesti: ${auth.matchedPhone}`);
    }

    const text = getMessageText(msg);
    if (!text) {
        return;
    }

    if (isHelpMessage(text)) {
        await sock.sendMessage(jid, { text: getHelpText() });
        return;
    }

    const daireNo = normalizeApartmentInput(text);
    if (!daireNo) {
        await sock.sendMessage(jid, { text: `Gecersiz daire kodu.\n\n${getHelpText()}` });
        return;
    }

    await sock.sendMessage(jid, { text: `${daireNo} icin borc bilgisi sorgulaniyor...` });

    const result = await getBorclar(daireNo);
    if (!result.success) {
        await sock.sendMessage(jid, { text: `Hata: ${result.message}` });
        return;
    }

    await sock.sendMessage(jid, { text: formatBorcMesaji(daireNo, result.data) });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            botConnected = false;
            console.log('\nWhatsApp QR hazir. Telefonunuzdan sunucu terminalindeki kodu taratin:\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('\nQR yenilenirse terminale tekrar basilir.\n');
        }

        if (connection === 'close') {
            botConnected = false;
            currentQR = null;

            const disconnectCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = disconnectCode !== DisconnectReason.loggedOut;

            console.log(`Baglanti kapandi. Kod: ${disconnectCode || 'bilinmiyor'}`);

            if (shouldReconnect) {
                startBot().catch((error) => {
                    console.error('Yeniden baglanma hatasi:', error);
                });
            }
        }

        if (connection === 'open') {
            botConnected = true;
            currentQR = null;
            console.log('WhatsApp baglantisi kuruldu. Bot aktif.');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        rememberPhoneMapping(lid, jid);
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') {
            return;
        }

        for (const msg of messages) {
            if (msg.key.fromMe) {
                continue;
            }

            try {
                await handleMessage(sock, msg);
            } catch (error) {
                console.error('Mesaj isleme hatasi:', error);
            }
        }
    });
}

console.log('Parkevler2 WhatsApp Bot baslatiliyor...');
startBot().catch((error) => {
    console.error('Bot baslatma hatasi:', error);
});
