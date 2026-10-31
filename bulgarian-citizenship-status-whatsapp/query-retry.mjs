import {nextScheduledDue, validateSchedule} from './core.mjs';
import {t} from './i18n.mjs';

const RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const weekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Istanbul', weekday: 'short',
});

/** Up to three automatic retries; weekend targets move to Monday's configured time. */
export function nextQueryRetryAt(now, retriesUsed, schedule = {time: '10:00'}) {
  if (typeof now !== 'number' || !Number.isFinite(now)
      || Number.isNaN(new Date(now).getTime())) {
    throw new RangeError(t('core_bad_time'));
  }
  if (!Number.isInteger(retriesUsed) || retriesUsed < 0) {
    throw new RangeError(t('qr_bad_count'));
  }
  if (retriesUsed >= RETRY_DELAYS_MS.length) return null;
  const target = now + RETRY_DELAYS_MS[retriesUsed];
  const day = weekday.format(new Date(target));
  if (day !== 'Sat' && day !== 'Sun') return target;
  const monday = validateSchedule({mode: 'weekly', weekDay: 1, time: schedule?.time ?? '10:00'});
  return nextScheduledDue(monday, target);
}
