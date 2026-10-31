import {normalizeStatus} from './core.mjs';

export const WHATSAPP_PERMISSION = 'https://web.whatsapp.com/*';
export const MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;

export function normalizePhone(input, {allowEmpty = false} = {}) {
  const text = String(input ?? '').trim();
  if (!text && allowEmpty) return '';
  if (!/^[+\d\s().-]+$/u.test(text)) throw new Error('Telefon numarasını ülke koduyla girin.');
  const digits = text.replace(/[+\s().-]/gu, '');
  if (digits.startsWith('0')) throw new Error('Numarayı başında 0 olmadan, ülke koduyla yazın (ör. +90 505 123 45 67).');
  if (!/^\d{8,15}$/u.test(digits)) throw new Error('Telefon numarası ülke koduyla birlikte 8 ile 15 rakam olmalı.');
  return digits;
}

export function normalizeGroupName(input) {
  const name = String(input ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 120 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('Grup adı 1 ile 120 karakter arasında olmalı.');
  }
  return name;
}

export const groupKey = (name) => normalizeGroupName(name).toLocaleLowerCase('tr');

export function normalizeRecipients(input, previous = {}) {
  const value = input === undefined ? previous : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WhatsApp alıcıları geçerli değil.');
  }
  const phones = value.phones ?? [];
  const groups = value.groups ?? [];
  if (!Array.isArray(phones) || !Array.isArray(groups)) throw new Error('Telefonları ve grupları liste olarak girin.');
  const uniquePhones = [...new Set(phones.filter((phone) => String(phone ?? '').trim()).map((phone) => normalizePhone(phone)))];
  const uniqueGroups = [];
  const seen = new Set();
  for (const item of groups) {
    if (!String(item ?? '').trim()) continue;
    const name = normalizeGroupName(item);
    const key = groupKey(name);
    if (!seen.has(key)) { seen.add(key); uniqueGroups.push(name); }
  }
  if (uniquePhones.length + uniqueGroups.length > 10) throw new Error('Her başvuru için en fazla 10 WhatsApp alıcısı ekleyebilirsiniz.');
  return {phones: uniquePhones, groups: uniqueGroups};
}

export function validateWhatsappConfig(input, previous = {}) {
  const value = input === undefined ? previous : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WhatsApp ayarları geçerli değil.');
  const enabled = Boolean(value.enabled);
  const senderPhone = normalizePhone(value.senderPhone ?? previous.senderPhone ?? '', {allowEmpty: !enabled});
  // Varsayilan kapali: yalnizca degisiklik gonderilir. Acilirsa ilk sonuc / degismeyen sonuc da gonderilir.
  const sendFirst = value.sendFirst === undefined ? Boolean(previous.sendFirst) : Boolean(value.sendFirst);
  const sendUnchanged = value.sendUnchanged === undefined ? Boolean(previous.sendUnchanged) : Boolean(value.sendUnchanged);
  return {enabled, senderPhone, sendFirst, sendUnchanged};
}

export async function whatsappTargetKey(account, config) {
  const recipients = normalizeRecipients(account.whatsappRecipients);
  const canonical = JSON.stringify({
    expectedSenderPhone: config.senderPhone,
    phones: [...recipients.phones].sort(), groups: recipients.groups.map(groupKey).sort(),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function makeChangeEvent(account, previousStatus, status, config, observedAt, {neverSent = false} = {}) {
  const before = normalizeStatus(previousStatus);
  const after = normalizeStatus(status);
  if (!config.enabled || !config.senderPhone || !after) return null;
  // kind: 'degisti' (durum degisti; her zaman) | 'ilk' (bu dosya icin WhatsApp'a HIC gonderilmedi + sendFirst; bir kez)
  //       | 'ayni' (degismedi + sendUnchanged). neverSent: arka plan, basarili gonderim kaydi ve bekleyen olay yoksa true verir.
  let kind;
  if (before && before !== after) kind = 'degisti';
  else if (neverSent && config.sendFirst) kind = 'ilk';
  else if (before && config.sendUnchanged) kind = 'ayni';
  else return null;
  const recipients = normalizeRecipients(account.whatsappRecipients);
  if (!recipients.phones.length && !recipients.groups.length) return null;
  return {
    id: crypto.randomUUID(), accountId: account.id, applicationNumber: account.applicationNumber, kind,
    previousStatus: before || '', status: after, observedAt,
    expectedSenderPhone: config.senderPhone, recipients, deliveries: [],
    targetKey: await whatsappTargetKey(account, config), attempts: 0, nextAttemptAt: observedAt,
  };
}

// Called by the query worker only after the initial check and all three retries fail.
// The cycle/case ID is stable so an interrupted enqueue cannot create a second alert.
export async function makeQueryFailureEvent(account, settings, now, {cycleId, nextDueAt, reason} = {}) {
  if (!settings?.enabled || !settings.senderPhone) return null;
  const recipients = normalizeRecipients(account.whatsappRecipients);
  if (!recipients.phones.length && !recipients.groups.length) return null;
  if (typeof cycleId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(cycleId)
      || !/^(?:[1-9]|10)$/u.test(String(account.id))
      || !/^\d{1,12}\/\d{4}$/u.test(account.applicationNumber || '')
      || typeof now !== 'number' || !Number.isFinite(now) || Number.isNaN(new Date(now).getTime())) {
    throw new Error('Kontrol hatası bildiriminin döngü bilgisi geçerli değil.');
  }
  const planned = typeof nextDueAt === 'number' && Number.isFinite(nextDueAt)
    && !Number.isNaN(new Date(nextDueAt).getTime()) ? nextDueAt : null;
  return {
    // 1.2.5: reason 'elle' = tekrar denenemeyen hata (form / sonuc / PIN); metni ve kimligi ayri.
    id: `${reason === 'elle' ? 'elle' : 'failure'}-${cycleId}-${account.id}`, accountId: account.id,
    applicationNumber: account.applicationNumber, kind: 'hata', previousStatus: '', status: '',
    ...(reason === 'elle' ? {failureReason: 'elle'} : {}),
    observedAt: now, ...(planned !== null ? {nextDueAt: planned} : {}),
    expectedSenderPhone: settings.senderPhone, recipients, deliveries: [],
    targetKey: await whatsappTargetKey(account, settings), attempts: 0, nextAttemptAt: now,
  };
}

export function retryDelayMs(attempts) {
  const exponential = 60_000 * (2 ** Math.min(19, Math.max(0, attempts - 1)));
  return Math.min(MAX_BACKOFF_MS, exponential);
}

const failureMessages = {
  whatsapp_permission_required: 'WhatsApp Web bağlantı izni eksik. Ayarlar sayfasından izin verin.',
  whatsapp_disabled: 'WhatsApp bildirimleri duraklatıldı.',
  whatsapp_not_ready: 'WhatsApp Web henüz hazır değil. Açık sekmede oturumun yüklenmesini bekleyin.',
  whatsapp_not_authenticated: 'WhatsApp Web oturumu açık değil. Tarayıcıdaki mevcut oturumunuzu kontrol edin.',
  whatsapp_sender_mismatch: 'Açık WhatsApp hesabı Ayarlar sayfasındaki gönderen numarasıyla eşleşmiyor.',
  whatsapp_group_not_found: 'Ayarlardaki WhatsApp gruplarından biri bulunamadı.',
  whatsapp_group_ambiguous: 'Aynı adda birden fazla WhatsApp grubu var. Grup adlarını ayırt edilecek şekilde düzenleyin.',
  whatsapp_target_invalid: 'WhatsApp alıcılarından biri doğrulanamadı.',
  whatsapp_recipient_unavailable: 'WhatsApp alıcılarından birine ulaşılamıyor.',
  whatsapp_send_failed: 'WhatsApp bildirimi gönderilemedi. Kayıt bekleyenler listesinde tutuluyor.',
  whatsapp_delivery_uncertain: 'Bir WhatsApp bildiriminin sonucu kesinleşmedi. Yinelenmemesi için otomatik tekrar durduruldu.',
  whatsapp_checkpoint_failed: 'WhatsApp gönderim ilerlemesi kaydedilemedi. Yinelenmemesi için gönderim durduruldu.',
  whatsapp_tab_unavailable: 'Mevcut WhatsApp Web sekmesi bulunamadı. Tarayıcıda açın.',
  whatsapp_vendor_unavailable: 'WhatsApp Web bağlantısı başlatılamadı. Tarayıcıdaki sekmeyi kontrol edin.',
};

export function whatsappErrorMessage(code) {
  return failureMessages[code] || 'WhatsApp bildirimi tamamlanamadı. Bekleyen kayıtlar korunuyor.';
}
