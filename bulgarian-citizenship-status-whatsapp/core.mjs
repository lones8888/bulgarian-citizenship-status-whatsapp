import { t, aktifDil } from "./i18n.mjs";

const TIME_ZONE = "Europe/Istanbul";
const localFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

function validTime(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)
      || Number.isNaN(new Date(timestamp).getTime())) {
    throw new RangeError(t("core_bad_time"));
  }
  return timestamp;
}

function localParts(timestamp) {
  validTime(timestamp);
  return Object.fromEntries(localFormatter.formatToParts(new Date(timestamp))
    .filter(({ type }) => type !== "literal")
    .map(({ type, value }) => [type, Number(value)]));
}

// Convert the intended wall-clock time using IANA data instead of assuming UTC+3.
function localInstant(year, monthIndex, day, hour, minute) {
  const target = Date.UTC(year, monthIndex, day, hour, minute, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const p = localParts(candidate);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const next = target - (shownAsUtc - candidate);
    if (next === candidate) return candidate;
    candidate = next;
  }
  throw new RangeError(t("core_month_calc"));
}

/** Validate and copy only the supported scheduling fields. */
export function validateSchedule(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RangeError(t('core_bad_schedule'));
  }
  const mode = input.mode ?? 'monthly';
  if (!['monthly', 'weekly', 'days'].includes(mode)) {
    throw new RangeError(t('core_choose_mode'));
  }
  const integer = (value, fallback, min, max, label) => {
    const number = value === undefined ? fallback
      : typeof value === 'string' && value.trim() ? Number(value) : value;
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new RangeError(t('core_range', { label, min, max }));
    }
    return number;
  };
  const time = input.time ?? '10:00';
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) {
    throw new RangeError(t('core_time_format'));
  }
  return {
    mode,
    monthDay: integer(input.monthDay, 1, 1, 31, t('lbl_monthday')),
    weekDay: integer(input.weekDay, 1, 0, 6, t('lbl_weekday')),
    days: integer(input.days, 7, 1, 365, t('lbl_days')),
    time,
  };
}

/** Next strictly future scheduled time, using the Istanbul calendar. */
export function nextScheduledDue(input, nowMs) {
  const schedule = validateSchedule(input);
  const p = localParts(nowMs);
  const [hour, minute] = schedule.time.split(':').map(Number);
  if (schedule.mode === 'days') {
    return localInstant(p.year, p.month - 1, p.day + schedule.days, hour, minute);
  }
  if (schedule.mode === 'weekly') {
    const currentDay = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const distance = (schedule.weekDay - currentDay + 7) % 7;
    const candidate = localInstant(p.year, p.month - 1, p.day + distance, hour, minute);
    return candidate > nowMs ? candidate
      : localInstant(p.year, p.month - 1, p.day + distance + 7, hour, minute);
  }
  const instant = (monthIndex) => {
    const lastDay = new Date(Date.UTC(p.year, monthIndex + 1, 0)).getUTCDate();
    return localInstant(p.year, monthIndex, Math.min(schedule.monthDay, lastDay), hour, minute);
  };
  const candidate = instant(p.month - 1);
  return candidate > nowMs ? candidate : instant(p.month);
}

/** Backward-compatible default: first day of a month, 10:00 Istanbul. */
export function nextMonthlyDue(nowMs) {
  return nextScheduledDue({}, nowMs);
}

/** Month of an instant in the schedule's time zone. */
export function dueMonth(timestamp) {
  const p = localParts(timestamp);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

export function normalizeStatus(text) {
  return typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
}

// Bilinen resmî durum cümleleri -> seçili dilde çeviri (pencere, Ayarlar ve WhatsApp aynı metni kullanır). Bilinmeyen
// cümle için "" döner: uydurma çeviri yapılmaz, mesajda resmî Bulgarca metin her zaman ayrıca bulunur.
const DURUM_CEVIRI = [
  ["Преписката се намира в процедура по задължително съгласуване.",
    { tr: "Dosya zorunlu koordinasyon prosedüründedir.", en: "The file is in the mandatory coordination procedure." }],
];
export function durumCevirisi(status, dil = aktifDil()) {
  const metin = normalizeStatus(status);
  return DURUM_CEVIRI.filter(([bg]) => metin.includes(bg)).map(([, ceviri]) => ceviri[dil] || ceviri.en).join(" ");
}
export const turkceDurum = (status) => durumCevirisi(status, "tr");

/** Fail closed: a validation error or unfamiliar result is never "unchanged". */
export function classifyResult(messages, applicationNumber) {
  const fail = (error) => ({ ok: false, error });
  if (typeof applicationNumber !== "string" || !/^\d+\/\d{4}$/u.test(applicationNumber)) {
    return fail(t("core_bad_number"));
  }
  if (!Array.isArray(messages) || messages.some((m) => typeof m !== "string")) {
    return fail(t("core_unreadable"));
  }
  const values = messages.map(normalizeStatus).filter(Boolean);
  if (values.length !== 1 || values[0].length > 8000) {
    return fail(t("core_no_single"));
  }
  const value = values[0];
  const match = /^Образувана преписка\s+N\s*:\s*(\d+\/\d{4})(?![\p{L}\p{N}/])\s*\.\s*(.+)$/iu.exec(value);
  if (!match || match[1] !== applicationNumber) {
    return fail(t("core_not_verified"));
  }
  const tail = match[2];
  if ((tail.match(/\p{L}/gu) || []).length < 8
      || /(?:\b(?:captcha|invalid|required|error|PIN)\b|невалид|неверен|грешка|ПИН)/iu.test(tail)) {
    return fail(t("core_site_error"));
  }
  return { ok: true, status: value };
}
