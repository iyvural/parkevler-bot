# Parkevler2 WhatsApp Bot

Bu bot, sadece izin verilen telefon numaralarindan gelen mesajlara cevap verir ve `A1-A10` ile `B1-B60` araligindaki daireler icin borc sorgusu yapar.

## Kurulum

1. `npm install`
2. `.env.example` dosyasini `.env` olarak kopyalayin
3. `.env` icindeki `ALLOWED_USERS` alanina cevap verilmesini istediginiz numaralari yazin
4. `npm start`
5. Sunucu terminalinde olusan QR kodu WhatsApp ile taratin

## QR kullanimi

- Bot baslayinca QR terminale basilacaktir
- Telefonda `WhatsApp > Bagli Cihazlar > Cihaz Ekle` yolunu izleyip terminaldeki QR'i okutun
- `/qr` adresi artik sadece terminalden taratmaniz gerektigini hatirlatir

## Telefon numarasi formati

- `ALLOWED_USERS` icine numaralari virgulle ayirin
- Ornek: `905551112233,05551112233,+90 544 111 22 33`
- Bot numaralari esnek normalize eder ve ayni kisiyi farkli formatlarda da tanir

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
