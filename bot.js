require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');

let currentQR = null;
let botConnected = false;
let didWarnMissingAllowedUsers = false;
let didWarnMissingAdminUsers = false;
const pendingLids = [];

const API_BASE_URL = process.env.API_BASE_URL || 'https://parkevler2sitesi.com.tr/api.php';
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_USERS = parseAllowedUsers(process.env.ALLOWED_USERS || '');
const ADMIN_USERS = parseAllowedUsers(process.env.ADMIN_USERS || '');
const ADMIN_CODE = String(process.env.ADMIN_CODE || '').trim();
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const LID_MAPPINGS_PATH = path.join(__dirname, 'lid-mappings.json');
const lidMappings = loadLidMappings();

http.createServer((req, res) => {
    if (req.url === '/qr') {
        if (botConnected) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bot zaten bagli. QR gerekli degil.');
            return;
        }

        if (currentQR) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('QR terminal uzerinde uretiliyor. Sunucu konsolundaki QR kodu taratin.');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('QR hazirlaniyor. Birazdan terminale basilacak.');
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
    res.end(botConnected ? 'Bot aktif ve bagli' : 'Bot baslatiliyor');
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

function loadLidMappings() {
    try {
        if (!fs.existsSync(LID_MAPPINGS_PATH)) {
            return { phoneToLid: {} };
        }

        const parsed = JSON.parse(fs.readFileSync(LID_MAPPINGS_PATH, 'utf8'));
        return {
            phoneToLid: parsed && typeof parsed.phoneToLid === 'object' ? parsed.phoneToLid : {},
        };
    } catch (error) {
        console.error('LID mapping dosyasi okunamadi:', error.message);
        return { phoneToLid: {} };
    }
}

function saveLidMappings() {
    fs.writeFileSync(LID_MAPPINGS_PATH, JSON.stringify(lidMappings, null, 2));
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

function extractPhoneFromChatId(chatId) {
    const value = String(chatId || '');
    if (!value.endsWith('@c.us')) {
        return '';
    }

    return normalizePhone(value.split('@')[0]);
}

function extractLidFromChatId(chatId) {
    const value = String(chatId || '');
    if (!value.endsWith('@lid')) {
        return '';
    }

    return value.split('@')[0];
}

function getMappedPhoneByLid(lid) {
    const normalizedLid = String(lid || '').trim();
    if (!normalizedLid) {
        return '';
    }

    for (const [phone, mappedLid] of Object.entries(lidMappings.phoneToLid)) {
        if (String(mappedLid) === normalizedLid) {
            return normalizePhone(phone);
        }
    }

    return '';
}

function setLidMapping(phone, lid) {
    const normalizedPhone = normalizePhone(phone);
    const normalizedLid = String(lid || '').trim();
    if (!normalizedPhone || !normalizedLid) {
        return false;
    }

    lidMappings.phoneToLid[normalizedPhone] = normalizedLid;
    saveLidMappings();
    return true;
}

function addPendingLid(lid) {
    const normalizedLid = String(lid || '').trim();
    if (!normalizedLid) {
        return;
    }

    const existing = pendingLids.find((entry) => entry.lid === normalizedLid);
    if (existing) {
        existing.seenAt = new Date().toISOString();
        return;
    }

    pendingLids.unshift({
        lid: normalizedLid,
        seenAt: new Date().toISOString(),
    });

    if (pendingLids.length > 20) {
        pendingLids.length = 20;
    }
}

function consumePendingLid(lid) {
    const index = pendingLids.findIndex((entry) => entry.lid === lid);
    if (index >= 0) {
        pendingLids.splice(index, 1);
    }
}

function isAllowedPhone(phone) {
    if (ALLOWED_USERS.size === 0) {
        if (!didWarnMissingAllowedUsers) {
            console.warn('UYARI: ALLOWED_USERS bos. Bot tum ozel mesajlari yanitlayacak.');
            didWarnMissingAllowedUsers = true;
        }
        return true;
    }

    const senderVariants = getPhoneVariants(phone);

    for (const allowedUser of ALLOWED_USERS) {
        const allowedVariants = getPhoneVariants(allowedUser);
        if (allowedVariants.some((variant) => senderVariants.includes(variant))) {
            return true;
        }
    }

    return false;
}

function isAdminPhone(phone) {
    if (ADMIN_USERS.size === 0) {
        if (!didWarnMissingAdminUsers) {
            console.warn('UYARI: ADMIN_USERS bos. Admin komutlari yalniz ADMIN_CODE ile calisacak.');
            didWarnMissingAdminUsers = true;
        }
        return false;
    }

    const senderVariants = getPhoneVariants(phone);

    for (const adminUser of ADMIN_USERS) {
        const adminVariants = getPhoneVariants(adminUser);
        if (adminVariants.some((variant) => senderVariants.includes(variant))) {
            return true;
        }
    }

    return false;
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

function getAdminHelpText() {
    return [
        'Admin komutlari',
        '',
        'bekleyenler',
        'onaylilar',
        'eslestir 905542812424',
        'eslestir 905542812424 27651033026731',
        'sil 905542812424',
        '',
        'ADMIN_CODE tanimliysa su da calisir:',
        'yonetici KOD bekleyenler',
        'yonetici KOD onaylilar',
        'yonetici KOD eslestir 905542812424',
    ].join('\n');
}

function resolveSenderIdentity(message) {
    const phone = extractPhoneFromChatId(message.from);
    if (phone) {
        return {
            phone,
            lid: '',
            rawId: message.from,
        };
    }

    const lid = extractLidFromChatId(message.from);
    if (lid) {
        return {
            phone: getMappedPhoneByLid(lid),
            lid,
            rawId: message.from,
        };
    }

    return {
        phone: '',
        lid: '',
        rawId: message.from,
    };
}

function parseAdminCommand(text) {
    const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return null;
    }

    const normalizedFirst = normalizeCommandText(parts[0]);
    if (normalizedFirst === 'bekleyenler') {
        return { type: 'pending' };
    }

    if (normalizedFirst === 'onaylilar') {
        return { type: 'approved' };
    }

    if (normalizedFirst === 'eslestir') {
        return {
            type: 'map',
            phone: normalizePhone(parts[1] || ''),
            lid: parts[2] || '',
            usedAdminCode: false,
        };
    }

    if (normalizedFirst === 'sil') {
        return {
            type: 'delete',
            phone: normalizePhone(parts[1] || ''),
            usedAdminCode: false,
        };
    }

    if (normalizedFirst === 'yonetici' && parts.length >= 3) {
        const normalizedCommand = normalizeCommandText(parts[2]);
        return {
            type: normalizedCommand === 'eslestir'
                ? 'map'
                : normalizedCommand === 'bekleyenler'
                    ? 'pending'
                    : normalizedCommand === 'onaylilar'
                        ? 'approved'
                        : normalizedCommand === 'sil'
                            ? 'delete'
                            : 'unknown',
            phone: normalizePhone(parts[3] || ''),
            lid: parts[4] || '',
            code: parts[1],
            usedAdminCode: true,
        };
    }

    return null;
}

function isAuthorizedForAdminCommand(identity, command) {
    if (identity.phone && isAdminPhone(identity.phone)) {
        return true;
    }

    if (!command?.usedAdminCode) {
        return false;
    }

    return Boolean(ADMIN_CODE) && command.code === ADMIN_CODE;
}

async function handleAdminCommand(message, identity, text) {
    const command = parseAdminCommand(text);
    if (!command) {
        return false;
    }

    if (!isAuthorizedForAdminCommand(identity, command)) {
        await message.reply('Admin yetkisi yok. Gecerli admin numarasi veya dogru ADMIN_CODE gerekli.');
        return true;
    }

    if (command.type === 'pending') {
        if (pendingLids.length === 0) {
            await message.reply('Bekleyen LID yok.');
            return true;
        }

        const lines = pendingLids.map((entry, index) => `${index + 1}. ${entry.lid} - ${entry.seenAt}`);
        await message.reply(`Bekleyen LID listesi\n\n${lines.join('\n')}`);
        return true;
    }

    if (command.type === 'approved') {
        const entries = Object.entries(lidMappings.phoneToLid);
        if (entries.length === 0) {
            await message.reply('Onayli eslesme yok.');
            return true;
        }

        const lines = entries.map(([phone, lid], index) => `${index + 1}. ${phone} = ${lid}`);
        await message.reply(`Onayli eslesmeler\n\n${lines.join('\n')}`);
        return true;
    }

    if (command.type === 'map') {
        if (!command.phone) {
            await message.reply(`Telefon numarasi eksik.\n\n${getAdminHelpText()}`);
            return true;
        }

        const lidToMap = String(command.lid || '').trim() || pendingLids[0]?.lid || '';
        if (!lidToMap) {
            await message.reply('Esletirilecek bekleyen LID bulunamadi. Once o kisi bota bir mesaj gondersin.');
            return true;
        }

        if (!setLidMapping(command.phone, lidToMap)) {
            await message.reply('Esleme kaydedilemedi.');
            return true;
        }

        consumePendingLid(lidToMap);
        await message.reply(`Esleme kaydedildi.\n${command.phone} = ${lidToMap}`);
        console.log(`Admin esleme kaydetti: ${command.phone} = ${lidToMap}`);
        return true;
    }

    if (command.type === 'delete') {
        if (!command.phone) {
            await message.reply(`Silinecek telefon numarasi eksik.\n\n${getAdminHelpText()}`);
            return true;
        }

        if (!lidMappings.phoneToLid[command.phone]) {
            await message.reply('Bu telefon icin kayitli eslesme yok.');
            return true;
        }

        delete lidMappings.phoneToLid[command.phone];
        saveLidMappings();
        await message.reply(`Eslesme silindi: ${command.phone}`);
        console.log(`Admin esleme sildi: ${command.phone}`);
        return true;
    }

    await message.reply(getAdminHelpText());
    return true;
}

async function handleMessage(message) {
    const chatId = message.from;
    if (!chatId || chatId.endsWith('@g.us')) {
        return;
    }

    const identity = resolveSenderIdentity(message);
    const text = String(message.body || '').trim();

    if (await handleAdminCommand(message, identity, text)) {
        return;
    }

    const senderPhone = identity.phone;
    if (!senderPhone) {
        if (identity.lid) {
            addPendingLid(identity.lid);
            console.log(`Telefon numarasi okunamadi: ${chatId} (bekleyen LID kaydedildi)`);
        } else {
            console.log(`Telefon numarasi okunamadi: ${chatId}`);
        }
        return;
    }

    if (!isAllowedPhone(senderPhone)) {
        console.log(`Izin verilmeyen numara engellendi: ${senderPhone}`);
        return;
    }

    if (!text) {
        return;
    }

    console.log(`Izinli kullanici eslesti: ${senderPhone}`);

    if (isHelpMessage(text)) {
        await message.reply(getHelpText());
        return;
    }

    const daireNo = normalizeApartmentInput(text);
    if (!daireNo) {
        await message.reply(`Gecersiz daire kodu.\n\n${getHelpText()}`);
        return;
    }

    await message.reply(`${daireNo} icin borc bilgisi sorgulaniyor...`);

    const result = await getBorclar(daireNo);
    if (!result.success) {
        await message.reply(`Hata: ${result.message}`);
        return;
    }

    await message.reply(formatBorcMesaji(daireNo, result.data));
}

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'parkevler-bot' }),
    puppeteer: {
        headless: true,
        executablePath: PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
        ],
    },
});

client.on('qr', (qr) => {
    currentQR = qr;
    botConnected = false;
    console.log('\nWhatsApp QR hazir. Telefonunuzdan sunucu terminalindeki kodu taratin:\n');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('\nQR yenilenirse terminale tekrar basilir.\n');
});

client.on('ready', () => {
    currentQR = null;
    botConnected = true;
    console.log('WhatsApp baglantisi kuruldu. Bot aktif.');
});

client.on('authenticated', () => {
    console.log('WhatsApp oturumu dogrulandi.');
});

client.on('auth_failure', (message) => {
    botConnected = false;
    console.error(`WhatsApp auth hatasi: ${message}`);
});

client.on('disconnected', (reason) => {
    botConnected = false;
    currentQR = null;
    console.log(`WhatsApp baglantisi kapandi: ${reason}`);
});

client.on('message', async (message) => {
    try {
        await handleMessage(message);
    } catch (error) {
        console.error('Mesaj isleme hatasi:', error);
    }
});

console.log('Parkevler2 WhatsApp Bot baslatiliyor...');
client.initialize().catch((error) => {
    console.error('Bot baslatma hatasi:', error);
});
