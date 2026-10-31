# Bulgarian Citizenship Status WhatsApp – Chrome Extension

**Automatic tracking at the interval you choose and WhatsApp notifications.**

Chrome / Brave extension that checks the status of up to 10 Bulgarian citizenship applications on the official Ministry of Justice page ([publicbg.mjs.bg](https://publicbg.mjs.bg/BgInfo/Home/Enroll)) and tells you when a status changes – as a desktop notification and, if you want, as a WhatsApp message to the numbers or groups you choose. **English and Turkish** interface (English by default).

*Bulgaristan vatandaşlık başvurusu: istediğin aralıkta otomatik takip ve WhatsApp bildirimi. [Türkçe açıklama aşağıda ↓](#türkçe)*

## Download

Direct download (always the latest version):

```text
https://github.com/lones8888/bulgarian-citizenship-status-whatsapp/releases/latest/download/bulgarian-citizenship-status-whatsapp.zip
```

One line on Windows: open a normal PowerShell window (administrator is not needed) and paste:

```powershell
irm https://raw.githubusercontent.com/lones8888/bulgarian-citizenship-status-whatsapp/main/install.ps1 | iex
```

It extracts the extension to `Desktop\bulgarian-citizenship-status-whatsapp`. Then continue from step 3 below.

## Step-by-step install (Chrome / Brave)

1. Download the zip and extract it.
2. Put the **bulgarian-citizenship-status-whatsapp** folder on your Desktop. Do not delete or move it later.
3. Type `chrome://extensions` in the address bar (Brave: `brave://extensions`).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the **bulgarian-citizenship-status-whatsapp** folder.
6. Click the extension icon → **Settings**: enter the application numbers and PINs, choose the interval and time → **Save**.
7. Press **Check all now** for the first check.

**Language:** the **EN / TR** switch in the small window, or **Language** at the top right of Settings. Desktop notifications and WhatsApp messages use the same language.

**WhatsApp:** sign in to WhatsApp Web in the same browser → in Settings enter your sender number and each application's recipients → turn WhatsApp sending on and save (allow web.whatsapp.com if asked) → **Send a test message to myself**.

**Update:** copy the new files over the same folder (or run the one line again) → `chrome://extensions` → **Reload** on the extension card. Settings and PINs are kept. Do not remove the extension; that deletes its data.

## Features

- **Automatic checks at the interval you choose:** monthly (default: the 1st, 10:00 Turkey time), weekly, or every 1–365 days. A check missed while the browser was closed runs when it opens again.
- **WhatsApp message on a status change:** application number, the status in your language (when known) and the official Bulgarian text, to the numbers and groups you choose. The PIN is never sent.
- **English / Turkish** interface, notifications and WhatsApp messages.
- Up to **10 applications**, each with its own recipients; notifies only on a real change.
- Small window with every application and its latest status.
- Human checks (Cloudflare) are never solved automatically: the tab is brought forward and you finish it. Temporary errors are retried after 15 minutes, 1 hour and 3 hours.
- PINs stay in the browser's local extension storage and are sent only to the ministry page.

## Notes

- Unofficial – not affiliated with the Bulgarian Ministry of Justice. It only reads the status; it never changes an application.
- WhatsApp sending uses the bundled [WPPConnect WA-JS](https://github.com/wppconnect-team/wa-js) (Apache-2.0), not an official WhatsApp API.
- The browser must be running and online for checks; a sleeping computer is not woken up.

---

## Türkçe

**İstediğin aralıkta otomatik takip ve WhatsApp bildirimi.** Bulgaristan vatandaşlık başvurularının (en fazla 10) durumunu Adalet Bakanlığı sayfasından kendisi sorgulayan Chrome / Brave eklentisi. Durum değişince bildirim gösterir, istersen seçtiğin WhatsApp numaralarına ve gruplarına mesaj atar. **İngilizce ve Türkçe** kullanılır (varsayılan İngilizce).

**İndirme linki (her zaman son sürüm):**

```text
https://github.com/lones8888/bulgarian-citizenship-status-whatsapp/releases/latest/download/bulgarian-citizenship-status-whatsapp.zip
```

**Windows'ta tek satırla:** normal PowerShell aç (yönetici gerekmez) ve yapıştır:

```powershell
irm https://raw.githubusercontent.com/lones8888/bulgarian-citizenship-status-whatsapp/main/install.ps1 | iex
```

Eklentiyi masaüstündeki `bulgarian-citizenship-status-whatsapp` klasörüne çıkarır. Sonra aşağıdaki 3. adımdan devam et.

### Adım adım kurulum (Chrome / Brave)

1. Zip'i indir ve aç.
2. İçindeki **bulgarian-citizenship-status-whatsapp** klasörünü masaüstüne koy. Sonra bu klasörü silme, taşıma.
3. Tarayıcının adres çubuğuna `chrome://extensions` yaz (Brave'de `brave://extensions`).
4. Sağ üstteki **Geliştirici modu**nu aç.
5. **Paketlenmemiş öğe yükle**'ye bas ve **bulgarian-citizenship-status-whatsapp** klasörünü seç.
6. Eklenti simgesine bas → **Settings** (Türkçe seçince **Ayarlar**): başvuru numaralarını ve PIN'leri yaz, kontrol aralığını ve saati seç → kaydet.
7. **Check all now** (**Tümünü şimdi kontrol et**) ile ilk sorguyu yap.

**Dil:** küçük penceredeki **EN / TR** düğmesi ya da Ayarlar'ın sağ üstündeki **Dil** seçimi. Masaüstü bildirimleri ve WhatsApp mesajları da seçilen dilde gider. Önceki sürümden güncellenen kurulum Türkçe kalır.

**WhatsApp bildirimi için:** aynı tarayıcıda WhatsApp Web'e giriş yap → Ayarlar'da gönderen numaranı ve her başvurunun alıcı numaralarını / gruplarını yaz → WhatsApp gönderimini aç ve kaydet (tarayıcı web.whatsapp.com izni isterse onayla) → **Kendime test mesajı gönder** ile dene.

**Güncelleme:** yeni zip'teki dosyaları aynı klasörün üzerine kopyala (ya da tek satırı tekrar çalıştır) → `chrome://extensions` → eklenti kartında **Yeniden yükle**. Ayarlar ve PIN'ler korunur. Eklentiyi kaldırma; kaldırırsan ayarlar silinir.

### Özellikler

- **İstediğin aralıkta otomatik takip:** her ay (varsayılan: ayın 1'i, saat 10.00), her hafta ya da 1–365 günde bir. Tarayıcı kapalıyken kaçan kontrol, tarayıcı açılınca yapılır.
- **WhatsApp bildirimi:** durum değişince başvuru numarası, seçili dilde durum (tanımlıysa) ve resmî Bulgarca metin seçtiğin numaralara ve gruplara gider. PIN mesaja hiç eklenmez.
- **İngilizce / Türkçe** arayüz, bildirim ve WhatsApp mesajı.
- En fazla **10 başvuru**, her birinin kendi alıcıları; sadece gerçek değişiklikte bildirim.
- İnsan doğrulamasını (Cloudflare) eklenti çözmez: sekmeyi öne getirir, sen tamamlarsın. Geçici hatada 15 dakika, 1 saat ve 3 saat sonra yeniden dener.
- PIN'ler sadece bu tarayıcıda saklanır ve sadece Bakanlık sayfasına gönderilir.

Ayrıntılı Türkçe kılavuz: [KURULUM.txt](bulgarian-citizenship-status-whatsapp/KURULUM.txt)

## License / Lisans

MIT – [LICENSE](LICENSE). `bulgarian-citizenship-status-whatsapp/vendor/wppconnect-wa.js` is WPPConnect WA-JS 4.7.2, Apache-2.0 (`vendor/LICENSE-WAJS.txt`, `vendor/NOTICE-WAJS.txt`).
