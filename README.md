# Parkevler2 WhatsApp Bot

Bu bot, `whatsapp-web.js` kullanir; sadece izin verilen telefon numaralarindan gelen mesajlara cevap verir ve `A1-A10` ile `B1-B60` araligindaki daireler icin borc sorgusu yapar.

## Kurulum

1. `npm install`
2. `.env.example` dosyasini `.env` olarak kopyalayin
3. `.env` icindeki `ALLOWED_USERS` alanina cevap verilmesini istediginiz numaralari yazin
4. `npm start`
5. Sunucu terminalinde olusan QR kodu WhatsApp ile taratin
6. Giris yapildiktan sonra oturum `.wwebjs_auth/` klasorunde saklanir

## QR kullanimi

- Bot baslayinca QR terminale basilacaktir
- Telefonda `WhatsApp > Bagli Cihazlar > Cihaz Ekle` yolunu izleyip terminaldeki QR'i okutun
- Oturum kaydi silinmezse her yeniden baslatmada tekrar QR gerekmez

## Telefon numarasi formati

- `ALLOWED_USERS` icine numaralari virgulle ayirin
- Ornek: `905551112233,05551112233,+90 544 111 22 33`
- Bot numaralari esnek normalize eder ve ayni kisiyi farkli formatlarda da tanir

## LID eslestirme

- Bazi kullanicilar WhatsApp tarafinda telefon yerine `lid` kimligi ile gelebilir
- Bu durumda bot cevap vermez ve LID'yi beklemeye alir
- Yonetici olarak su komutlari kullanabilirsiniz:
- `bekleyenler`
- `eslestir 905542812424`
- `eslestir 905542812424 27651033026731`
- `ADMIN_USERS` tanimli degilse veya admin numarasi da `lid` geliyorsa, `.env` icinde `ADMIN_CODE` tanimlayip su sekilde kullanabilirsiniz:
- `yonetici KOD eslestir 905542812424`
- Eslesmeler `lid-mappings.json` dosyasinda saklanir

## Daire sorgusu

Kullanici sadece su formatlarda mesaj gondermelidir:

- `A1` ... `A10`
- `B1` ... `B60`

Kucuk-buyuk harf fark etmez. Ornek:

- `a4`
- `B54`

## API

Bot su istegi atar:

- `GET https://parkevler2sitesi.com.tr/api.php?action=payment-filter&daireno=A4&status=odenmedi`

API bos dizi dondururse borc yok kabul edilir.

## Ubuntu notu

`whatsapp-web.js` Chrome/Chromium tabanli calisir. Ubuntu sunucuda eksikse su paketler gerekebilir:

```bash
sudo apt update
sudo apt install -y chromium-browser
```

Eger Chromium farkli bir yoldaysa `.env` icine ekleyebilirsiniz:

```env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```
