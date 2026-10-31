import {nextScheduledDue, validateSchedule, classifyResult, normalizeStatus} from './core.mjs';
import {validateWhatsappConfig, normalizeRecipients, groupKey, whatsappTargetKey, makeChangeEvent,
  makeQueryFailureEvent, retryDelayMs, WHATSAPP_PERMISSION, whatsappErrorMessage} from './whatsapp.mjs';
import {checkWebStatus, sendWebEvent, sendWebTest} from './whatsapp-web.mjs';
import {nextQueryRetryAt} from './query-retry.mjs';

const TARGET = 'https://publicbg.mjs.bg/BgInfo/Home/Enroll';
const MONTHLY = 'monthly-check';
const TIMEOUT = 'query-timeout';
const WA_DELIVERY = 'wa-delivery';
const QUERY_RETRY = 'query-retry';
// One total budget includes ordinary browser verification. A submitted form is never sent twice.
const DEADLINE_MS = 300_000;
let serial = Promise.resolve();
let restoredPendingId = null;
let whatsappSerial = Promise.resolve();
const enqueue = (fn) => {
  const task = serial.then(async () => { await ready; return fn(); });
  serial = task.catch(() => {});
  return task;
};
const read = () => chrome.storage.local.get(['config', 'state']);
const writeState = (state) => chrome.storage.local.set({state});

async function scheduleQueryRetry(config, state) {
  const retries = Object.entries(state.queryRetries || {}).filter(([id, retry]) =>
    Number.isFinite(retry.nextAt) && config.accounts.some((account) =>
      account.id === id && account.applicationNumber === retry.applicationNumber));
  if (!config.enabled || state.batch || !retries.length) {
    await chrome.alarms.clear(QUERY_RETRY);
    return;
  }
  await chrome.alarms.create(QUERY_RETRY, {
    when: Math.max(Date.now() + 30_000, Math.min(...retries.map(([, retry]) => retry.nextAt)))
  });
}

async function recordQueryFailure(state, config, account, pending, result, now) {
  state.queryRetries ||= {};
  const used = pending.retryAttempt || 0;
  const retryable = result.retryable === true;
  const nextAt = retryable && config.enabled ? nextQueryRetryAt(now, used, config.schedule) : null;
  const priorRetry = state.queryRetries[account.id];
  const cycleId = priorRetry?.cycleId || state.batch?.cycleId || crypto.randomUUID();
  let error = result.error || 'Sorgu tamamlanamadı. Resmî siteyi kontrol edin.';
  if (nextAt) {
    error += ` Yeni kontrol: ${new Intl.DateTimeFormat('tr-TR', {timeZone: 'Europe/Istanbul',
      dateStyle: 'short', timeStyle: 'short'}).format(nextAt)}.`;
  } else if (retryable && used >= 3) {
    error += ' Üç otomatik tekrar da tamamlanamadı; sıradaki takvim zamanı beklenecek.';
  }
  if (retryable) {
    state.queryRetries[account.id] = {applicationNumber: account.applicationNumber,
      retriesUsed: used, nextAt, cycleId, failureQueued: priorRetry?.failureQueued || false};
    if (used >= 3 && !state.queryRetries[account.id].failureQueued) {
      whatsappState(state);
      const nextDueAt = state.nextDueAt > now ? state.nextDueAt : nextScheduledDue(config.schedule, now);
      const notice = await makeQueryFailureEvent(account, config.whatsapp, now, {cycleId, nextDueAt});
      if (notice && !state.whatsappOutbox.some((event) => event.id === notice.id)) state.whatsappOutbox.push(notice);
      state.queryRetries[account.id].failureQueued = true;
      whatsappState(state);
    }
  } else {
    delete state.queryRetries[account.id];
    // 1.2.5: tekrar denenemeyen hata (form degisti / sonuc okunamadi / PIN) icin her basvuruya BIR KEZ "Elle kontrol gerekli".
    // Ayni basvuru basarili sorgulanana kadar ikinci kez gonderilmez.
    state.manualCheckAlerts ||= {};
    if (state.manualCheckAlerts[account.id] !== account.applicationNumber) {
      whatsappState(state);
      const nextDueAt = state.nextDueAt > now ? state.nextDueAt : nextScheduledDue(config.schedule, now);
      const notice = await makeQueryFailureEvent(account, config.whatsapp, now, {cycleId, nextDueAt, reason: 'elle'});
      if (notice && !state.whatsappOutbox.some((event) => event.id === notice.id)) state.whatsappOutbox.push(notice);
      if (notice) state.manualCheckAlerts[account.id] = account.applicationNumber;
      whatsappState(state);
    }
  }
  state.results[account.id] = {...state.results[account.id],
    applicationNumber: account.applicationNumber, lastError: error, lastAttemptAt: now, retryAt: nextAt};
  state.lastError = 'En az bir başvuru kontrol edilemedi. Başvuru kartlarını inceleyin.';
  state.batch.hadError = true;
}

async function startRetryBatch() {
  const {config, state} = await read();
  if (!config.enabled || state.batch) { await scheduleQueryRetry(config, state); return; }
  const due = Object.entries(state.queryRetries || {}).filter(([id, retry]) =>
    Number.isFinite(retry.nextAt) && retry.nextAt <= Date.now() && retry.retriesUsed < 3
    && config.accounts.some((account) => account.id === id && account.applicationNumber === retry.applicationNumber));
  if (!due.length) { await scheduleQueryRetry(config, state); return; }
  state.batch = {queue: due.map(([id]) => id), retry: true, hadError: false, changed: false};
  await badge('…');
  await startNext(state, config);
}

function whatsappState(state) {
  state.whatsappOutbox ||= [];
  state.whatsappDelivery ||= {};
  state.whatsapp = {lastSentAt: null, lastError: '', ...state.whatsapp,
    pendingCount: state.whatsappOutbox.length};
  delete state.whatsapp.lastQueuedAt;
}

function whatsappHeads(state) {
  // A failed A→B must be acknowledged before the same case's later B→C event.
  return state.whatsappOutbox.filter((event, index, all) =>
    all.findIndex((other) => other.accountId === event.accountId) === index);
}

async function whatsappPermission() {
  return chrome.permissions.contains({origins: [WHATSAPP_PERMISSION]});
}

async function compatibleWhatsappHeads(config, state) {
  const compatible = [];
  for (const event of whatsappHeads(state)) {
    const account = config.accounts.find((item) => item.id === event.accountId
      && item.applicationNumber === event.applicationNumber);
    if (account && event.targetKey === await whatsappTargetKey(account, config.whatsapp)) {
      compatible.push(event);
    }
  }
  return compatible;
}

async function scheduleWhatsapp(config, state) {
  whatsappState(state);
  const settings = config.whatsapp;
  if (!settings?.enabled || !settings.senderPhone || !state.whatsappOutbox.length) {
    await chrome.alarms.clear(WA_DELIVERY);
    return;
  }
  const heads = whatsappHeads(state);
  const matchingHeads = await compatibleWhatsappHeads(config, state);
  const compatible = matchingHeads.filter((event) => !event.blocked);
  if (!compatible.length) {
    if (matchingHeads.length) {
      state.whatsapp.lastError ||= 'WhatsApp bağlantısını Ayarlar sayfasından kontrol edin.';
    } else {
      state.whatsapp.lastError = 'Bekleyen değişikliğin alıcısı veya göndereni değişti. Eski kayıt farklı bir alıcıya yönlendirilmedi.';
    }
    await writeState(state);
    await chrome.alarms.clear(WA_DELIVERY);
    return;
  }
  const next = Math.min(...compatible.map((event) => event.nextAttemptAt || 0));
  await chrome.alarms.create(WA_DELIVERY, {when: Math.max(Date.now() + 30_000, next)});
}

function requestWhatsappFlush() {
  const task = whatsappSerial.then(flushWhatsapp);
  whatsappSerial = task.catch(() => {});
  return task;
}

async function flushWhatsapp() {
  // Browser delivery runs outside the query queue; only snapshots and checkpoints share its lock.
  const delivery = await enqueue(async () => {
    const {config, state} = await read();
    whatsappState(state);
    if (!config.whatsapp?.enabled || !config.whatsapp.senderPhone || !state.whatsappOutbox.length) {
      await scheduleWhatsapp(config, state);
      return null;
    }
    const event = (await compatibleWhatsappHeads(config, state)).find((item) =>
      !item.blocked && (item.nextAttemptAt || 0) <= Date.now());
    if (!event) { await scheduleWhatsapp(config, state); return null; }
    if (!await whatsappPermission()) {
      state.whatsapp.lastError = whatsappErrorMessage('whatsapp_permission_required');
      await writeState(state);
      await chrome.alarms.clear(WA_DELIVERY);
      return null;
    }
    event.attempts = (event.attempts || 0) + 1;
    event.nextAttemptAt = Date.now() + retryDelayMs(event.attempts);
    await writeState(state);
    return {event: structuredClone(event)};
  });
  if (!delivery) return;
  let acknowledgement;
  let failure;
  const checkpoint = (updatedEvent) => enqueue(async () => {
    if (!updatedEvent || updatedEvent.id !== delivery.event.id || !Array.isArray(updatedEvent.deliveries)) {
      throw new Error('Invalid delivery checkpoint');
    }
    const {state} = await read();
    whatsappState(state);
    const queued = state.whatsappOutbox.find((event) => event.id === delivery.event.id);
    if (!queued) throw new Error('Delivery event is missing');
    // Only delivery progress is mutable. Routing and sender snapshots stay immutable.
    queued.deliveries = structuredClone(updatedEvent.deliveries);
    await writeState(state);
  });
  try {
    const result = await sendWebEvent(delivery.event, checkpoint);
    if (result?.ok === true && (result.delivered === true || result.state === 'sent')) acknowledgement = result;
    else failure = {message: whatsappErrorMessage(result?.error), retryable: result?.retryable !== false};
  }
  catch (error) {
    failure = {message: whatsappErrorMessage(error?.code), retryable: error?.retryable !== false};
  }
  await enqueue(async () => {
    const {config, state} = await read();
    whatsappState(state);
    const index = state.whatsappOutbox.findIndex((event) => event.id === delivery.event.id);
    if (index < 0) return;
    const event = state.whatsappOutbox[index];
    if (acknowledgement) {
      state.whatsappOutbox.splice(index, 1);
      if (event.kind !== 'hata') {
        state.whatsappDelivery[event.accountId] = {
          lastSentStatus: event.status, lastSentChangeId: event.id, lastSentAt: Date.now(),
        };
      }
      state.whatsapp.lastSentAt = Date.now();
      state.whatsapp.lastError = '';
    } else {
      state.whatsapp.lastError = failure.message;
      event.nextAttemptAt = Date.now() + retryDelayMs(event.attempts);
      event.blocked = !failure.retryable;
    }
    whatsappState(state);
    await writeState(state);
    await scheduleWhatsapp(config, state);
    // Basarili gonderimden sonra sirada zamani gelmis baska mesaj varsa 30 sn'lik zamanlayici beklenmez, hemen gonderilir.
    // Basarisiz olanin zamani ileri atildigi icin dongu olusmaz.
    if (acknowledgement && (await compatibleWhatsappHeads(config, state))
      .some((item) => !item.blocked && (item.nextAttemptAt || 0) <= Date.now())) void requestWhatsappFlush();
  });
}

function isOfficial(url, allowVerificationQuery = false) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://publicbg.mjs.bg'
      && parsed.pathname === '/BgInfo/Home/Enroll'
      && (!parsed.search || allowVerificationQuery && [...parsed.searchParams.keys()]
        .every((key) => key.startsWith('__cf_chl')));
  } catch { return false; }
}

async function badge(text, color = '#295c47') {
  await chrome.action.setBadgeBackgroundColor({color});
  await chrome.action.setBadgeText({text});
}

async function notify(id, title, message) {
  // Do not expose application numbers, status details or PINs on the lock screen.
  try {
    await chrome.notifications.create(id, {
      type: 'basic', iconUrl: 'icon128.png', title, message
    });
  } catch {
    // Results and errors remain visible in the extension if OS notifications fail.
  }
}

async function schedule(config, state) {
  if (!config.enabled || !config.accounts.length) {
    await chrome.alarms.clear(MONTHLY);
    return;
  }
  const when = Math.max(Date.now() + 30_000, state.nextDueAt);
  const alarm = await chrome.alarms.get(MONTHLY);
  if (!alarm || Math.abs(alarm.scheduledTime - when) > 2000) {
    await chrome.alarms.create(MONTHLY, {when});
  }
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const saved = await read();
  const config = saved.config || {enabled: true, accounts: [], schedule: validateSchedule({})};
  config.schedule = validateSchedule(config.schedule || {});
  config.whatsapp = validateWhatsappConfig(config.whatsapp);
  config.accounts = config.accounts.map((account) => ({...account,
    whatsappRecipients: normalizeRecipients(account.whatsappRecipients)}));
  const state = saved.state || {
    nextDueAt: nextScheduledDue(config.schedule, Date.now()), results: {}, history: [], lastError: ''
  };
  whatsappState(state);
  state.queryRetries ||= {};
  restoredPendingId = state.pending?.id || null;
  await chrome.storage.local.set({config, state});
  await schedule(config, state);
  await scheduleWhatsapp(config, state);
  await scheduleQueryRetry(config, state);
  if (state.pending) {
    await chrome.alarms.create(TIMEOUT, {
      when: Math.max(Date.now() + 30_000, state.pending.deadline)
    });
  }
  // Recover a quit/crash between recording one result and opening the next case.
  if (state.batch && !state.pending) await startNext(state, config);
}

async function startNext(state, config) {
  if (!state.batch?.queue.length) {
    const batch = state.batch;
    delete state.batch;
    delete state.pending;
    if (!batch?.retry) state.nextDueAt = nextScheduledDue(config.schedule, Date.now());
    const hasErrors = config.accounts.some((account) => state.results[account.id]?.lastError);
    if (hasErrors) state.lastError = 'En az bir başvuru kontrol edilemedi. Başvuru kartlarını inceleyin.';
    else state.lastError = '';
    // All cases are independently recorded. A partial run is never "all unchanged".
    if (!batch?.hadError && !hasErrors) state.lastSuccessAt = Date.now();
    await writeState(state);
    await schedule(config, state);
    await scheduleWhatsapp(config, state);
    await scheduleQueryRetry(config, state);
    // Kontrol biter bitmez gonderim baslar (zamanlayici yedek kalir). Beklenmez: gonderim kendi sirasinda, sorgu kilidi
    // bu gorev bitince birakilir. Ayni olayin iki kez gitmesini whatsappSerial + teslim kayitlari onler.
    if (state.whatsappOutbox.length && config.whatsapp?.enabled) void requestWhatsappFlush();
    await chrome.alarms.clear(TIMEOUT);
    if (batch?.hadError || hasErrors) {
      await badge('!', '#ae3f30');
      await notify('check-error', 'Başvuru kontrolü tamamlanamadı',
        Object.values(state.queryRetries || {}).some((retry) => Number.isFinite(retry.nextAt))
          ? 'Geçici hata var; otomatik yeniden kontrol planlandı. Ayrıntılar eklentide.'
          : 'Kontrol tamamlanamadı. Sıradaki takvim zamanı beklenecek. Ayrıntılar eklentide.');
    } else if (batch?.changed) {
      await badge('YENİ');
      await notify('status-changed', 'Başvuru durumunda değişiklik var',
        'Güncel sonucu görmek için tıklayın.');
    } else {
      await badge('');
    }
    return;
  }
  const accountId = state.batch.queue.shift();
  const account = config.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error('Başvuru ayarları bulunamadı.');
  let retryAttempt = 0;
  if (state.batch.retry) {
    const retry = state.queryRetries?.[accountId];
    if (!retry || retry.retriesUsed >= 3) { await startNext(state, config); return; }
    retry.retriesUsed += 1;
    retry.nextAt = null;
    retryAttempt = retry.retriesUsed;
  }
  state.pending = {
    id: crypto.randomUUID(), accountId, phase: 'loading', tabId: null,
    deadline: Date.now() + DEADLINE_MS, cleanUrlOpened: false,
    waitingForVerification: false, retryAttempt
  };
  await writeState(state);
  await chrome.alarms.create(TIMEOUT, {when: state.pending.deadline});
  try {
    const tab = await chrome.tabs.create({
      url: `${TARGET}#aylik-takip=${state.pending.id}`, active: !state.batch.formSeen
    });
    state.pending.tabId = tab.id;
    await writeState(state);
  } catch {
    await finishOne(state, config, {ok: false, retryable: true, error: 'Sorgu sekmesi açılamadı.'});
  }
}

async function startBatch(manual = false) {
  const {config, state} = await read();
  if (state.batch) return {ok: true, running: true};
  if (!config.accounts.length) throw new Error('Önce başvuru numarası ve PIN kaydedin.');
  if (!manual && (!config.enabled || Date.now() < state.nextDueAt)) {
    await schedule(config, state);
    return {ok: true};
  }
  state.lastError = '';
  state.queryRetries = {};
  await chrome.alarms.clear(QUERY_RETRY);
  state.batch = {queue: config.accounts.map((item) => item.id), cycleId: crypto.randomUUID(),
    hadError: false, changed: false, formSeen: false};
  await badge('…');
  await startNext(state, config);
  return {ok: true};
}

async function finishOne(state, config, result) {
  const pending = state.pending;
  if (!pending || !state.batch) return;
  const account = config.accounts.find((item) => item.id === pending.accountId);
  const previous = state.results[account.id] || {};
  const now = Date.now();
  if (result.ok) {
    if (state.queryRetries) delete state.queryRetries[account.id];
    if (state.manualCheckAlerts) delete state.manualCheckAlerts[account.id];
    const changed = Boolean(normalizeStatus(previous.lastStatus)
      && normalizeStatus(previous.lastStatus) !== normalizeStatus(result.status));
    whatsappState(state);
    // "Ilk sonucu gonder": bu dosya icin basarili gonderim kaydi da bekleyen olay da yoksa mevcut durum bir kez gider.
    const neverSent = !state.whatsappDelivery[account.id]
      && !state.whatsappOutbox.some((event) => event.accountId === account.id);
    const changeEvent = await makeChangeEvent(account, previous.lastStatus, result.status,
      config.whatsapp, now, {neverSent});
    if (changeEvent) state.whatsappOutbox.push(changeEvent);
    whatsappState(state);
    state.results[account.id] = {
      applicationNumber: account.applicationNumber, lastStatus: result.status,
      lastSuccessAt: now, lastError: ''
    };
    state.history = [{at: now, applicationNumber: account.applicationNumber,
      status: result.status, changed}, ...state.history].slice(0, 36);
    state.batch.changed ||= changed;
    // Only close the successful query tab created by this extension.
    if (pending.tabId != null) {
      try { await chrome.tabs.remove(pending.tabId); } catch {}
    }
  } else {
    await recordQueryFailure(state, config, account, pending, result, now);
    // If the first page never reached a usable form, do not open the other cases against the same outage.
    if (result.retryable && !state.batch.formSeen && pending.phase === 'loading') {
      for (const id of state.batch.queue) {
        const remaining = config.accounts.find((item) => item.id === id);
        if (!remaining) continue;
        const retryAttempt = state.batch.retry ? (state.queryRetries?.[id]?.retriesUsed || 0) + 1 : 0;
        await recordQueryFailure(state, config, remaining, {retryAttempt}, result, now);
      }
      state.batch.queue = [];
    }
    // Leave a failed/challenged tab available for the person to review.
  }
  delete state.pending;
  await writeState(state);
  await startNext(state, config);
}

async function saveConfig(message) {
  const {config: old, state} = await read();
  if (state.batch) throw new Error('Kontrol devam ediyor. Kaydetmeden önce bitmesini bekleyin.');
  if (!Array.isArray(message.accounts) || message.accounts.length > 10) {
    throw new Error('En fazla 10 başvuru ekleyebilirsiniz.');
  }
  const accounts = [];
  for (const item of message.accounts) {
    const id = String(item.id);
    const applicationNumber = String(item.applicationNumber || '').trim();
    if (!applicationNumber) continue;
    if (!/^(?:[1-9]|10)$/.test(id) || !/^\d{1,12}\/\d{4}$/.test(applicationNumber)
      || accounts.some((a) => a.id === id || a.applicationNumber === applicationNumber)) {
      throw new Error('Başvuru numaralarını numara/yıl biçiminde, tekrarlamadan girin.');
    }
    const previous = old.accounts.find((a) => a.id === id && a.applicationNumber === applicationNumber);
    const pin = String(item.pin || '').trim() || previous?.pin;
    if (!pin || pin.length > 100) throw new Error('Her yeni başvuru için PIN girin.');
    const whatsappRecipients = normalizeRecipients(item.whatsappRecipients, previous?.whatsappRecipients);
    accounts.push({id, applicationNumber, pin, whatsappRecipients});
  }
  const config = {enabled: Boolean(message.enabled), accounts,
    schedule: validateSchedule(message.schedule || {}),
    whatsapp: validateWhatsappConfig(message.whatsapp, old.whatsapp)};
  for (const id of Object.keys(state.results)) {
    if (!accounts.some((a) => a.id === id && a.applicationNumber === state.results[id].applicationNumber)) {
      delete state.results[id];
    }
  }
  state.history = state.history.filter((h) => accounts.some((a) => a.applicationNumber === h.applicationNumber));
  state.lastError = '';
  whatsappState(state);
  if (JSON.stringify(old.whatsapp) !== JSON.stringify(config.whatsapp)
      || JSON.stringify(old.accounts.map((item) => item.whatsappRecipients))
        !== JSON.stringify(config.accounts.map((item) => item.whatsappRecipients))) {
    state.whatsapp.lastError = '';
    for (const event of state.whatsappOutbox) {
      const account = config.accounts.find((item) => item.id === event.accountId
        && item.applicationNumber === event.applicationNumber);
      if (account && event.targetKey === await whatsappTargetKey(account, config.whatsapp)) {
        delete event.blocked; event.nextAttemptAt = Date.now();
      }
    }
  }
  if (!state.nextDueAt || JSON.stringify(old.schedule) !== JSON.stringify(config.schedule)
      || (!old.enabled && config.enabled)) {
    state.nextDueAt = nextScheduledDue(config.schedule, Date.now());
  }
  await chrome.storage.local.set({config, state});
  await schedule(config, state);
  await scheduleWhatsapp(config, state);
  for (const id of Object.keys(state.queryRetries || {})) {
    if (!accounts.some((account) => account.id === id
        && account.applicationNumber === state.queryRetries[id].applicationNumber)) delete state.queryRetries[id];
  }
  await writeState(state);
  await scheduleQueryRetry(config, state);
  return {ok: true};
}

function pageSender(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0
    && sender.tab?.id != null && isOfficial(sender.url, true);
}

async function handle(message, sender) {
  if (!message || sender.id !== chrome.runtime.id) return {ok: false, error: 'İstek reddedildi.'};
  if (pageSender(sender)) {
    const {config, state} = await read();
    const job = state.pending;
    if (!job || job.tabId !== sender.tab.id) return {ok: true, job: null};
    if (Date.now() > job.deadline) {
      await finishOne(state, config, {ok: false, retryable: true, error: 'Sorgu zaman aşımına uğradı. Siteyi kontrol edin.'});
      return {ok: false, error: 'Zaman aşımı.'};
    }
    const canonical = isOfficial(sender.url);
    if (!canonical && !['page-job', 'page-wait', 'page-error', 'page-clean-url', 'page-result'].includes(message.type)) {
      return {ok: false, error: 'Doğrulamanın resmî sorgu adresine dönmesi bekleniyor.'};
    }
    const account = config.accounts.find((a) => a.id === job.accountId);
    if (message.type === 'page-job') {
      return {ok: true, job: {id: job.id, phase: job.phase, deadline: job.deadline,
        isSubmissionDocument: job.phase === 'submitted' && sender.documentId === job.submissionDocumentId,
        canCleanVerificationUrl: !canonical && job.phase === 'loading'
          && !job.submissionDocumentId && !job.cleanUrlOpened}};
    }
    if (message.jobId !== job.id) return {ok: false, error: 'Sorgu eşleşmedi.'};
    if (message.type === 'page-wait' && message.reason === 'verification') {
      if (typeof sender.documentId !== 'string' || !sender.documentId) {
        return {ok: false, error: 'Doğrulama belgesi doğrulanamadı.'};
      }
      job.waitingForVerification = true;
      const attentionShown = job.verificationAttentionShown;
      job.verificationAttentionShown = true;
      await writeState(state);
      // Verification may need a foreground tab or a person. Notify only once for this job.
      if (!attentionShown) {
        try { await chrome.tabs.update(job.tabId, {active: true}); } catch {}
        await notify(`verification-${job.id}`, 'Cloudflare doğrulaması var',
          'Sorgu sekmesini açıp kontrol edin. Doğrulama bitince sorgu devam edecek.');
      }
      return {ok: true};
    }
    if (message.type === 'page-clean-url') {
      if (canonical || job.phase !== 'loading' || job.submissionDocumentId || job.cleanUrlOpened
          || typeof sender.documentId !== 'string' || !sender.documentId) {
        return {ok: false, error: 'Sorgu adresi yeniden açılmadı.'};
      }
      // An ordinary clean GET is allowed once, before any credential release/form submission.
      // The verification token is never rewritten while a challenge is active by the content script.
      job.cleanUrlOpened = true;
      await writeState(state);
      try {
        await chrome.tabs.update(job.tabId, {url: TARGET});
        return {ok: true, cleaned: true};
      } catch {
        return {ok: false, error: 'Sorgu sekmesi açılamadı. Sekmeyi kontrol edin.'};
      }
    }
    if (message.type === 'page-submit' && job.phase === 'loading') {
      if (typeof sender.documentId !== 'string' || !sender.documentId) {
        return {ok: false, error: 'Sorgu belgesi doğrulanamadı.'};
      }
      // Persist the submission phase before releasing credentials. Reloads never resubmit.
      job.phase = 'submitted';
      job.submissionDocumentId = sender.documentId;
      job.waitingForVerification = false;
      if (state.batch) state.batch.formSeen = true;
      await writeState(state);
      return {ok: true, applicationNumber: account.applicationNumber, pin: account.pin};
    }
    if (message.type === 'page-result' && job.phase === 'submitted') {
      // Only a new document loaded after form submission can supply the result.
      if (typeof sender.documentId !== 'string' || !sender.documentId
          || sender.documentId === job.submissionDocumentId) {
        return {ok: false, error: 'Yeni sorgu sonucu bekleniyor.'};
      }
      // Rendering can lag behind navigation; an absent summary is not a completed query.
      if (Array.isArray(message.messages) && !message.messages.some((text) => typeof text === 'string' && text.trim())) {
        return {ok: false, waiting: true, error: 'Sorgu sonucu bekleniyor.'};
      }
      const result = classifyResult(message.messages, account.applicationNumber);
      await finishOne(state, config, result);
      return {ok: true};
    }
    if (message.type === 'page-error') {
      const safeErrors = {
        challenge: 'Site insan doğrulaması istiyor. Açık sorgu sekmesini kontrol edin.',
        form: 'Sorgu formu bulunamadı veya değişti. Resmî siteyi kontrol edin.',
        submit: 'Sorgu gönderilemedi. Resmî siteyi kontrol edin.'
      };
      await finishOne(state, config, {ok: false, error: safeErrors[message.code] || safeErrors.form});
      return {ok: true};
    }
    return {ok: false, error: 'Geçersiz sorgu adımı.'};
  }
  // UI-only operations are never exposed to a website/content script.
  const optionsSender = sender.url === chrome.runtime.getURL('options.html');
  const popupSender = sender.url === chrome.runtime.getURL('popup.html');
  if ((!optionsSender && !popupSender) || sender.tab?.url?.startsWith('https:')) {
    return {ok: false, error: 'İstek reddedildi.'};
  }
  if (['save-config', 'notification-test', 'whatsapp-status', 'whatsapp-test'].includes(message.type) && !optionsSender) {
    return {ok: false, error: 'Bu işlem yalnızca Ayarlar sayfasından yapılabilir.'};
  }
  if (message.type === 'ui-state') {
    const {config, state} = await read();
    // Queue delivery records and internal snapshots are not part of the UI contract.
    const {whatsappOutbox, manualCheckAlerts, ...visibleState} = state;
    return {ok: true, config: {enabled: config.enabled, schedule: config.schedule, accounts: config.accounts.map(
      ({id, applicationNumber, pin, whatsappRecipients}) => ({id, applicationNumber,
        hasPin: Boolean(pin), whatsappRecipients})),
      whatsapp: {enabled: config.whatsapp.enabled, senderPhone: config.whatsapp.senderPhone,
        sendFirst: Boolean(config.whatsapp.sendFirst), sendUnchanged: Boolean(config.whatsapp.sendUnchanged)}},
      state: visibleState, notificationPermission: await chrome.notifications.getPermissionLevel()};
  }
  if (message.type === 'whatsapp-status') {
    const {config, state} = await read();
    if (!await whatsappPermission()) return {ok: false, error: whatsappErrorMessage('whatsapp_permission_required')};
    const groups = new Map();
    for (const account of config.accounts) {
      for (const name of account.whatsappRecipients.groups) groups.set(groupKey(name), name);
    }
    try {
      const status = await checkWebStatus(config.whatsapp, {groupNames: [...groups.values()]});
      // İzin sonradan verildiyse bekleyen değişiklikler yeniden zamanlanır (gönderim yine kuyruktan, kendi kurallarıyla).
      if (status.connected && status.senderMatches) await scheduleWhatsapp(config, state);
      return {ok: true, status: {
        connected: Boolean(status.connected), senderMatches: Boolean(status.senderMatches),
        senderMasked: String(status.senderMasked || '').slice(0, 30),
        groupMatches: Array.isArray(status.groupMatches) ? status.groupMatches.map(({name, count}) =>
          ({name: String(name).slice(0, 120), count: Number.isInteger(count) && count >= 0 ? count : 0})) : [],
        lastError: status.lastError ? whatsappErrorMessage(status.lastError) : '',
      }};
    } catch (error) { return {ok: false, error: whatsappErrorMessage(error?.code)}; }
  }
  if (message.type === 'whatsapp-test') {
    const {config} = await read();
    if (!config.whatsapp?.enabled || !config.whatsapp.senderPhone) {
      return {ok: false, error: 'Önce WhatsApp bildirimini açıp gönderen numarasını kaydet.'};
    }
    if (!await whatsappPermission()) return {ok: false, error: whatsappErrorMessage('whatsapp_permission_required')};
    let recipients = null;
    if (message.target === 'recipients') {
      const phones = new Set(); const groups = new Map();
      for (const account of config.accounts) {
        for (const item of account.whatsappRecipients.phones) phones.add(item);
        for (const name of account.whatsappRecipients.groups) groups.set(groupKey(name), name);
      }
      if (!phones.size && !groups.size) return {ok: false, error: 'Kayıtlı WhatsApp alıcısı yok. Başvurunun altındaki kişi / grup alanını doldurup kaydet.'};
      recipients = {phones: [...phones], groups: [...groups.values()]};
    }
    try {
      const result = await sendWebTest(config.whatsapp, recipients);
      return result?.ok ? {ok: true, sent: result.sent} : {ok: false, error: whatsappErrorMessage(result?.error)};
    } catch (error) { return {ok: false, error: whatsappErrorMessage(error?.code)}; }
  }
  if (message.type === 'save-config') return saveConfig(message);
  if (message.type === 'check-now') return startBatch(true);
  if (message.type === 'mark-read') { await badge(''); return {ok: true}; }
  if (message.type === 'notification-test') {
    await notify('notification-test', 'Vatandaşlık Takip hazır', 'Bu bir deneme bildirimidir.');
    return {ok: true};
  }
  return {ok: false, error: 'Bilinmeyen işlem.'};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => handle(message, sender)).then(sendResponse,
    () => sendResponse({ok: false, error: 'İşlem tamamlanamadı. Eklentiyi yeniden açın.'}));
  return true;
});
chrome.notifications.onClicked.addListener(async () => {
  // Older Chromium versions can deny openPopup; never replace the compact view with Settings.
  try {
    if (typeof chrome.action.openPopup === 'function') await chrome.action.openPopup();
  } catch {}
});
chrome.runtime.onInstalled.addListener(() => enqueue(async () => {
  const {config} = await read();
  if (!config.accounts.length) await badge('?', '#7b5d29');
}));
chrome.runtime.onStartup.addListener(() => enqueue(async () => {
  const {config, state} = await read();
  if (state.pending && state.pending.id === restoredPendingId) {
    await finishOne(state, config, {ok: false, error: 'Tarayıcı kapanınca sorgu yarım kaldı. Şimdi kontrol et ile tekrar deneyin.'});
  }
  if (!state.batch) await startBatch(false);
}));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WA_DELIVERY) return requestWhatsappFlush();
  return enqueue(async () => {
  if (alarm.name === MONTHLY) await startBatch(false);
  if (alarm.name === QUERY_RETRY) await startRetryBatch();
  if (alarm.name === TIMEOUT) {
    const {config, state} = await read();
    if (state.pending && Date.now() >= state.pending.deadline) {
      await finishOne(state, config, {ok: false, retryable: true,
        error: state.pending.waitingForVerification
          ? 'Cloudflare doğrulaması bitmedi. Sekmeyi açıp tamamla, sonra tekrar dene.'
          : 'Sorgu 5 dakika içinde tamamlanamadı. Bağlantıyı ve açık sorgu sekmesini kontrol edin.'});
    } else if (state.pending) {
      // An old query's queued timeout must never fail the next account in the batch.
      await chrome.alarms.create(TIMEOUT, {when: state.pending.deadline});
    }
  }
  });
});

const ready = initialize();
