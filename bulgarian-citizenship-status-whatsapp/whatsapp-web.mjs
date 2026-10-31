// Uses only the user's existing WhatsApp Web session. No relay, linked device or remote code.
import {durumCevirisi} from './core.mjs';
import {t, yerel} from './i18n.mjs';
export const WHATSAPP_ORIGIN = 'https://web.whatsapp.com/*';
const HOME = 'https://web.whatsapp.com/';
const VENDOR = 'vendor/wppconnect-wa.js';
let initializing = null;

class WebError extends Error {
  constructor(code, retryable = true) { super(code); this.code = code; this.retryable = retryable; }
}

function phone(value) {
  if (typeof value !== 'string' || /[^+\d\s().-]/u.test(value)) throw new WebError('whatsapp_target_invalid', false);
  const result = value.replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(result)) throw new WebError('whatsapp_target_invalid', false);
  return result;
}
function groupName(value) {
  if (typeof value !== 'string') throw new WebError('whatsapp_target_invalid', false);
  const result = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!result || result.length > 200) throw new WebError('whatsapp_target_invalid', false);
  return result;
}
function safeUrl(value) { try { const u = new URL(value); return u.origin === 'https://web.whatsapp.com'; } catch { return false; } }
function failure(code, retryable = true, extra = {}) { return { ok: false, error: code, retryable, ...extra }; }

// Chrome serializes this function. It intentionally has NO references to module variables.
async function pageTask(operation, payload = {}) {
  const SPACE = '__BG_MONTHLY_WHATSAPP_WEB_V1';
  const store = globalThis[SPACE] || (globalThis[SPACE] = { tail: Promise.resolve(), plans: new Map(), attempts: new Map(), injectionAt: 0 });
  const perform = async () => {
    const str = value => typeof value === 'string' ? value : value?._serialized || value?.toString?.() || '';
    const fold = value => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('tr');
    const bounded = (promise, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const library = globalThis.WPP;
    if (operation === 'probe') {
      return { present: Boolean(library), ready: Boolean(library?.isReady), claimed: store.injectionAt > Date.now() - 30_000 };
    }
    if (operation === 'claim') {
      if (library || store.injectionAt > Date.now() - 30_000) return false;
      store.injectionAt = Date.now(); return true;
    }
    if (!library?.isReady) return { ok: false, error: 'whatsapp_not_ready', retryable: true, invoked: false };
    let authenticated = false, ownId = '';
    try {
      authenticated = Boolean(await library.conn.isAuthenticated());
      ownId = str(await library.conn.getMyUserId());
    } catch { return { ok: false, error: 'whatsapp_vendor_unavailable', retryable: true, invoked: false }; }
    const ownMatch = ownId.match(/^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/u);
    const ownPhone = ownMatch?.[1] || '';
    const info = {
      connected: Boolean(authenticated && ownPhone),
      senderMatches: Boolean(ownPhone && ownPhone === payload.senderPhone),
      senderMasked: ownPhone ? `***${ownPhone.slice(-4)}` : '', groupMatches: [], lastError: null
    };
    if (!info.connected) info.lastError = 'whatsapp_not_authenticated';
    else if (!info.senderMatches) info.lastError = 'whatsapp_sender_mismatch';
    if (operation === 'status' && info.lastError) return info;
    if (operation !== 'status' && info.lastError) return { ok: false, error: info.lastError, retryable: info.lastError !== 'whatsapp_sender_mismatch', invoked: false };

    const findGroups = async names => {
      if (!names.length) return [];
      const all = await bounded(library.group.getAllGroups(), 10_000);
      return names.map(name => {
        const matches = all.filter(g => {
          if (!g) return false;
          const actualName = typeof g.name === 'string' ? g.name : typeof g.formattedTitle === 'string' ? g.formattedTitle : g.groupMetadata?.subject;
          return fold(actualName) === fold(name);
        });
        return { name, matches };
      });
    };
    if (operation === 'status') {
      try { info.groupMatches = (await findGroups(payload.groupNames || [])).map(x => ({ name: x.name, count: x.matches.length })); }
      catch { info.lastError = 'whatsapp_group_lookup_failed'; }
      return info; // No chat objects, messages, contacts or full phone numbers leave the page.
    }
    if (operation === 'prepare') {
      const fingerprint = JSON.stringify([payload.senderPhone, payload.phones, payload.groups]);
      const oldPlan = store.plans.get(payload.id);
      if (oldPlan) {
        if (oldPlan.fingerprint !== fingerprint) return { ok: false, error: 'whatsapp_target_invalid', retryable: false, invoked: false };
        return { ok: true, deliveries: oldPlan.deliveries };
      }
      let requestedGroups;
      try { requestedGroups = await findGroups(payload.groups); }
      catch { return { ok: false, error: 'whatsapp_group_lookup_failed', retryable: true, invoked: false }; }
      if (requestedGroups.some(x => x.matches.length > 1)) return { ok: false, error: 'whatsapp_group_ambiguous', retryable: false, invoked: false };
      if (requestedGroups.some(x => x.matches.length === 0)) return { ok: false, error: 'whatsapp_group_not_found', retryable: true, invoked: false };
      const requested = [];
      for (const x of requestedGroups) {
        const jid = str(x.matches[0].id);
        if (!/^\d+(?:-\d+)?@g\.us$/u.test(jid)) return { ok: false, error: 'whatsapp_target_invalid', retryable: false, invoked: false };
        requested.push({ kind: 'group', name: x.name, jid });
      }
      // Resolve only explicitly requested people. Never enumerate contacts or read chat messages.
      for (const num of payload.phones) {
        try {
          const requestedJid = `${num}@c.us`;
          const chat = await bounded(library.chat.find(requestedJid), 10_000);
          const jid = str(chat?.id);
          if (!/^\d+@(?:c\.us|lid)$/u.test(jid)) return { ok: false, error: 'whatsapp_recipient_unavailable', retryable: true, invoked: false };
          requested.push({ kind: 'phone', jid });
        } catch { return { ok: false, error: 'whatsapp_recipient_unavailable', retryable: true, invoked: false }; }
      }
      const deliveries = [];
      for (const target of requested) {
        if (deliveries.some(x => x.jid === target.jid)) continue;
        try {
          const key = await bounded(library.chat.generateMessageID(target.jid), 5000);
          const messageId = str(key);
          if (!key.fromMe || str(key.remote) !== target.jid || !messageId.startsWith('true_')) return { ok: false, error: 'whatsapp_message_id_unavailable', retryable: true, invoked: false };
          deliveries.push({ ...target, messageId, state: 'pending' });
        } catch { return { ok: false, error: 'whatsapp_message_id_unavailable', retryable: true, invoked: false }; }
      }
      if (!deliveries.length) return { ok: false, error: 'whatsapp_target_invalid', retryable: false, invoked: false };
      if (store.plans.size >= 200) store.plans.delete(store.plans.keys().next().value);
      store.plans.set(payload.id, { fingerprint, deliveries });
      return { ok: true, deliveries };
    }
    if (operation !== 'deliver') return { ok: false, error: 'whatsapp_target_invalid', retryable: false, invoked: false };

    const target = payload.delivery;
    const old = store.attempts.get(target.messageId);
    if (old?.state === 'sent') return { ok: true, ack: old.ack, messageId: target.messageId, recovered: true };
    // Query only this specific outgoing message key; never return a message model or its body.
    let existing = null, lookupMissing = false;
    try { existing = await bounded(library.chat.getMessageById(target.messageId), 8000); }
    catch (e) { lookupMissing = e?.code === 'msg_not_found' || e?.name === 'msg_not_found'; }
    if (existing && Number(existing.ack) >= 1) {
      store.attempts.set(target.messageId, { state: 'sent', ack: Number(existing.ack) });
      return { ok: true, ack: Number(existing.ack), messageId: target.messageId, recovered: true };
    }
    if (old || !payload.allowSend || existing) return { ok: false, error: 'whatsapp_delivery_uncertain', retryable: false, uncertain: true, invoked: Boolean(old || existing) };
    if (!lookupMissing) return { ok: false, error: 'whatsapp_message_lookup_failed', retryable: true, invoked: false };
    if (store.attempts.size >= 1000) return { ok: false, error: 'whatsapp_page_memory_full', retryable: false, invoked: false };
    // Record the attempt BEFORE invoking WhatsApp. Page-global serialized calls prevent a second invocation.
    store.attempts.set(target.messageId, { state: 'sending' });
    try {
      const result = await bounded(library.chat.sendTextMessage(target.jid, payload.text, {
        messageId: target.messageId, markIsRead: false, detectMentioned: false,
        waitForAck: true, linkPreview: false, delay: 0
      }), 45_000);
      const id = str(result?.id);
      const clearlySent = Number(result?.ack) >= 1 || ['OK', 'SUCCESS'].includes(result?.sendMsgResult?.messageSendResult);
      if (id === target.messageId && clearlySent) {
        const ack = Number(result.ack) >= 1 ? Number(result.ack) : 1;
        store.attempts.set(target.messageId, { state: 'sent', ack });
        return { ok: true, ack, messageId: target.messageId, invoked: true };
      }
    } catch { /* Do not expose transport errors, which can contain phone numbers or message bodies. */ }
    store.attempts.set(target.messageId, { state: 'uncertain' });
    return { ok: false, error: 'whatsapp_delivery_uncertain', retryable: false, uncertain: true, invoked: true };
  };
  // A single promise chain in the page also protects across service-worker suspension/restart.
  // Read-only probes must not wait behind a slow send (and must keep readiness checks bounded).
  if (['probe', 'claim', 'status'].includes(operation)) return perform();
  const next = store.tail.catch(() => {}).then(perform);
  store.tail = next.catch(() => {});
  return next;
}

async function execute(tabId, operation, payload) {
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: pageTask, args: [operation, payload] });
  if (!results?.[0] || results[0].error) throw new WebError('whatsapp_tab_unavailable');
  return results[0].result;
}

async function ensureTab() {
  if (initializing) return initializing;
  initializing = (async () => {
    if (!await chrome.permissions.contains({ origins: [WHATSAPP_ORIGIN] })) throw new WebError('whatsapp_permission_required', false);
    const deadline = Date.now() + 60_000;   // arka plan sekmesinde WhatsApp Web ilk yukleme 25 sn yi gecebiliyor
    const within = promise => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new WebError('whatsapp_not_ready')), Math.max(1, deadline - Date.now()));
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const available = (await within(chrome.tabs.query({ url: WHATSAPP_ORIGIN }))).filter(t => t.id && safeUrl(t.url) && !t.incognito);
    const tab = available.find(t => t.active) || available[0] || await chrome.tabs.create({ url: HOME, active: false });
    if (!Number.isInteger(tab?.id)) throw new WebError('whatsapp_tab_unavailable');
    while (Date.now() < deadline) {
      try {
        const current = await within(chrome.tabs.get(tab.id));
        if (!safeUrl(current.url)) throw new WebError('whatsapp_tab_unavailable');
        const probe = await within(execute(tab.id, 'probe', {}));
        if (probe?.ready) return tab.id;
        if (!probe?.present && !probe?.claimed && await within(execute(tab.id, 'claim', {}))) {
          await within(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', files: [VENDOR] }));
        }
      } catch (e) { if (e instanceof WebError && !e.retryable) throw e; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new WebError('whatsapp_not_ready');
  })();
  try { return await initializing; } finally { initializing = null; }
}

export async function checkWebStatus(config, { groupNames = [] } = {}) {
  const base = { connected: false, senderMatches: false, senderMasked: '', groupMatches: [], lastError: null };
  if (!config?.enabled) return { ...base, lastError: 'whatsapp_disabled' };
  try {
    const senderPhone = phone(config.senderPhone);
    if (!Array.isArray(groupNames) || groupNames.length > 10) throw new WebError('whatsapp_target_invalid', false);
    const groups = [...new Set(groupNames.map(groupName))];
    const tabId = await ensureTab();
    const result = await execute(tabId, 'status', { senderPhone, groupNames: groups });
    if (result?.error) return { ...base, lastError: result.error };
    return {
      connected: Boolean(result?.connected), senderMatches: Boolean(result?.senderMatches),
      senderMasked: typeof result?.senderMasked === 'string' ? result.senderMasked : '',
      groupMatches: Array.isArray(result?.groupMatches) ? result.groupMatches.map(x => ({ name: String(x.name), count: Number(x.count) || 0 })) : [],
      lastError: result?.lastError || null
    };
  } catch (e) { return { ...base, lastError: e instanceof WebError ? e.code : 'whatsapp_tab_unavailable' }; }
}

function eventData(event) {
  if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 160 || !/^\d{1,12}\/\d{4}$/u.test(event.applicationNumber || '')) throw new WebError('whatsapp_event_invalid', false);
  // A PIN is never selected, transmitted, or interpolated into a page execution.
  if (Object.keys(event).some(k => /^pin$/iu.test(k))) throw new WebError('whatsapp_pin_not_allowed', false);
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
  const kind = event.kind === undefined ? 'degisti' : event.kind;
  if (!['degisti', 'ilk', 'ayni', 'hata'].includes(kind)) throw new WebError('whatsapp_event_invalid', false);
  const status = normalize(event.status), before = normalize(event.previousStatus);
  if (kind === 'hata') {
    if (status || before) throw new WebError('whatsapp_event_invalid', false);
  } else if (!status || (kind !== 'ilk' && !before) || status.length > 6000 || before.length > 6000 || /(?:^|[^\p{L}])(?:pin|пин)(?:$|[^\p{L}])/iu.test(status + ' ' + before)) throw new WebError('whatsapp_event_invalid', false);
  const when = typeof event.observedAt === 'number' ? event.observedAt : Date.parse(event.observedAt);
  if (!Number.isFinite(when) || Number.isNaN(new Date(when).getTime())) throw new WebError('whatsapp_event_invalid', false);
  const senderPhone = phone(event.expectedSenderPhone);
  if (!Array.isArray(event.recipients?.phones) || !Array.isArray(event.recipients?.groups) || event.recipients.phones.length > 10 || event.recipients.groups.length > 10) throw new WebError('whatsapp_target_invalid', false);
  const phones = [...new Set(event.recipients.phones.map(phone))];
  const groups = [...new Map(event.recipients.groups.map(groupName).map(x => [x.toLocaleLowerCase('tr'), x])).values()];
  if (!phones.length && !groups.length) throw new WebError('whatsapp_target_invalid', false);
  if (kind === 'hata') {
    const planned = typeof event.nextDueAt === 'number' && Number.isFinite(event.nextDueAt)
      && !Number.isNaN(new Date(event.nextDueAt).getTime())
      ? new Date(event.nextDueAt).toLocaleString(yerel(), {timeZone: 'Europe/Istanbul'})
      : t('msg_per_schedule');
    const neden = event.failureReason === 'elle' ? t('msg_reason_manual') : t('msg_reason_retries');
    const text = `${t('msg_fail_title')}\n${t('msg_file')}: ${event.applicationNumber}\n${neden}\n${t('msg_next_planned')}: ${planned}`;
    return {id: event.id, senderPhone, phones, groups, text, same: false};
  }
  const date = new Date(when).toLocaleString(yerel(), { timeZone: 'Europe/Istanbul' });
  const baslik = { degisti: [t('msg_changed'), t('msg_new_status')],
    ilk: [t('msg_started'), t('msg_current')],
    ayni: [t('msg_same'), t('msg_status')] }[kind];
  const ceviri = durumCevirisi(status) || t('msg_no_translation');
  const text = `${baslik[0]}\n${t('msg_file')}: ${event.applicationNumber}\n${t('msg_checked')}: ${date}\n\n${baslik[1]}:\n${ceviri}\n\n${t('msg_official')}:\n${status}`;
  return { id: event.id, senderPhone, phones, groups, text, same: kind === 'degisti' && status === before };
}

function validDelivery(item) {
  return item && ['phone', 'group'].includes(item.kind) && typeof item.jid === 'string'
    && /^\d+(?:-\d+)?@(?:c\.us|lid|g\.us)$/u.test(item.jid)
    && typeof item.messageId === 'string' && item.messageId.startsWith(`true_${item.jid}_`)
    && ['pending', 'sending', 'sent', 'uncertain'].includes(item.state);
}

export async function sendWebEvent(event, onCheckpoint) {
  let data;
  try { data = eventData(event); }
  catch (e) { return failure(e instanceof WebError ? e.code : 'whatsapp_event_invalid', false); }
  if (data.same) return { ok: true, state: 'unchanged', deliveries: [] };
  if (typeof onCheckpoint !== 'function') return failure('whatsapp_checkpoint_failed', false);
  const checkpoint = async () => {
    try { await onCheckpoint(event); }
    catch { throw new WebError('whatsapp_checkpoint_failed'); }
  };
  let tabId;
  try {
    tabId = await ensureTab();
    if (!Array.isArray(event.deliveries) || !event.deliveries.length) {
      const plan = await execute(tabId, 'prepare', { id: data.id, senderPhone: data.senderPhone, phones: data.phones, groups: data.groups });
      if (!plan?.ok) return failure(plan?.error || 'whatsapp_target_invalid', plan?.retryable !== false);
      if (!Array.isArray(plan.deliveries) || !plan.deliveries.length || !plan.deliveries.every(validDelivery)) return failure('whatsapp_target_invalid', false);
      event.deliveries = structuredClone(plan.deliveries);
      await checkpoint(); // Stable IDs and the complete destination snapshot are durable before any send.
    }
    if (!event.deliveries.every(validDelivery)) return failure('whatsapp_target_invalid', false);
    for (const delivery of event.deliveries) {
      if (delivery.state === 'sent') continue;
      const allowSend = delivery.state === 'pending' && !delivery.attemptedAt;
      if (allowSend) { delivery.state = 'sending'; delivery.attemptedAt = Date.now(); await checkpoint(); }
      let result;
      try {
        result = await execute(tabId, 'deliver', { senderPhone: data.senderPhone, delivery: { kind: delivery.kind, jid: delivery.jid, messageId: delivery.messageId }, text: data.text, allowSend });
      } catch {
        delivery.state = 'uncertain'; await checkpoint();
        return failure('whatsapp_delivery_uncertain', false, { uncertain: true, deliveries: event.deliveries });
      }
      if (result?.ok && Number(result.ack) >= 1 && result.messageId === delivery.messageId) {
        delivery.state = 'sent'; delivery.ack = Number(result.ack); delivery.sentAt = Date.now(); await checkpoint();
        continue;
      }
      if (result?.uncertain || result?.invoked) {
        delivery.state = 'uncertain'; await checkpoint();
        return failure('whatsapp_delivery_uncertain', false, { uncertain: true, deliveries: event.deliveries });
      }
      // The page conclusively says WhatsApp's send was never invoked: a future retry is safe.
      delivery.state = 'pending'; delete delivery.attemptedAt; await checkpoint();
      return failure(result?.error || 'whatsapp_send_failed', result?.retryable !== false, { deliveries: event.deliveries });
    }
    return { ok: true, state: 'sent', deliveries: event.deliveries };
  } catch (e) {
    return failure(e instanceof WebError ? e.code : 'whatsapp_tab_unavailable', e instanceof WebError ? e.retryable : true, { deliveries: event.deliveries || [] });
  }
}

// Ayarlar > test düğmeleri: aynı hazırlama/gönderme yolu. recipients verilmezse alıcı yalnızca gönderen hesabın kendisidir
// ("kendime mesaj"); verilirse kayıtlı kişi ve gruplara. Başvuru numarası, durum veya PIN içermez; outbox'a yazılmaz.
export async function sendWebTest(config, recipients = null) {
  if (!config?.enabled) return failure('whatsapp_disabled', false);
  let senderPhone, phones, groups;
  try {
    senderPhone = phone(config.senderPhone);
    phones = recipients ? [...new Set((recipients.phones || []).map(phone))] : [senderPhone];
    groups = recipients ? [...new Map((recipients.groups || []).map(groupName).map(x => [x.toLocaleLowerCase('tr'), x])).values()] : [];
    if (!phones.length && !groups.length) throw new WebError('whatsapp_target_invalid', false);
    if (phones.length > 10 || groups.length > 10) throw new WebError('whatsapp_target_invalid', false);
  } catch (e) { return failure(e instanceof WebError ? e.code : 'whatsapp_target_invalid', false); }
  try {
    const tabId = await ensureTab();
    const plan = await execute(tabId, 'prepare', { id: `test-${crypto.randomUUID()}`, senderPhone, phones, groups });
    if (!plan?.ok) return failure(plan?.error || 'whatsapp_target_invalid', plan?.retryable !== false);
    if (!Array.isArray(plan.deliveries) || !plan.deliveries.length || !plan.deliveries.every(validDelivery)) return failure('whatsapp_target_invalid', false);
    const date = new Date().toLocaleString(yerel(), { timeZone: 'Europe/Istanbul' });
    const text = t('msg_test', { date });
    let sent = 0;
    for (const delivery of plan.deliveries) {
      const result = await execute(tabId, 'deliver', { senderPhone, delivery: { kind: delivery.kind, jid: delivery.jid, messageId: delivery.messageId }, text, allowSend: true });
      if (!(result?.ok && Number(result.ack) >= 1)) return failure(result?.error || 'whatsapp_send_failed', false, { sent });
      sent++;
    }
    return { ok: true, sent };
  } catch (e) {
    return failure(e instanceof WebError ? e.code : 'whatsapp_tab_unavailable', false);
  }
}
