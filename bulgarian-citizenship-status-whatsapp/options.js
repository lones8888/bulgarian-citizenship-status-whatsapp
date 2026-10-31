import { t, dilAyarla, aktifDil, yerel, sayfayiCevir } from "./i18n.mjs";
import { durumCevirisi } from "./core.mjs";

const $ = (id) => document.getElementById(id);
const form = $("settings-form");
const enabledInput = $("enabled");
const checkButton = $("check");
const saveButton = $("save");
const testButton = $("notification-test");
const whatsappEnabled = $("whatsapp-enabled");
const whatsappSender = $("whatsapp-sender");
const whatsappSendFirst = $("whatsapp-send-first");
const whatsappSendUnchanged = $("whatsapp-send-unchanged");
const whatsappStatusButton = $("whatsapp-status-check");
const whatsappTestButton = $("whatsapp-test-send");
const whatsappTestRecipientsButton = $("whatsapp-test-recipients");
const slots = Array.from({ length: 10 }, (_, index) => String(index + 1));
const defaultSchedule = { mode: "monthly", monthDay: 1, weekDay: 1, days: 7, time: "10:00" };
const numberInput = (id) => $(`account-number-${id}`);
const pinInput = (id) => $(`account-pin-${id}`);
const phonesInput = (id) => $(`account-phones-${id}`);
const groupsInput = (id) => $(`account-groups-${id}`);
let initialised = false;
let dirty = false;
let busy = false;
let currentData = null;
let refreshInProgress = false;
let refreshAgain = false;
let lastWhatsappStatus = null;

const formatters = {};
function dateText(value) {
  if (!value) return t("not_yet");
  const parsed = new Date(value);
  const formatter = formatters[aktifDil()] ||= new Intl.DateTimeFormat(yerel(), {
    timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short"
  });
  return Number.isFinite(parsed.getTime()) ? formatter.format(parsed) : "—";
}
function feedback(message, isError = false) {
  $("feedback").textContent = message;
  $("feedback").classList.toggle("error", isError);
}
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || t("opt_err_generic"));
  return response;
}
// Dil: sabit yazilar data-i18n ile, degisen yazilar render() ile secili dile gecer.
function applyLanguage(language) {
  dilAyarla(language);
  sayfayiCevir();
  $("language").value = aktifDil();
}
function plainError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return t("opt_last_failed");
}
function translateKnownStatus(status) {
  return durumCevirisi(status) || t("official_below");
}
function savedAccounts() {
  return Array.isArray(currentData?.config?.accounts) ? currentData.config.accounts : [];
}
function scheduleText(schedule = defaultSchedule) {
  const s = { ...defaultSchedule, ...schedule };
  if (s.mode === "weekly") return t("sched_weekly", { day: t(`wd_${s.weekDay}`), time: s.time });
  if (s.mode === "days") return t("sched_days", { n: s.days, time: s.time });
  return t("sched_monthly", { n: s.monthDay, time: s.time });
}
function updateScheduleControls() {
  const mode = $("schedule-mode").value;
  for (const [type, inputId] of [["monthly", "schedule-monthday"], ["weekly", "schedule-weekday"], ["days", "schedule-days"]]) {
    $(`${type}-field`).hidden = mode !== type;
    $(inputId).disabled = busy || mode !== type;
  }
  $("schedule-mode").disabled = busy;
  $("schedule-time").disabled = busy;
}
function setButtons() {
  const accounts = savedAccounts();
  const ready = accounts.length > 0 && accounts.every((account) => account.hasPin);
  const pending = currentData?.state?.pending || currentData?.state?.batch;
  saveButton.disabled = busy || Boolean(pending);
  testButton.disabled = busy;
  enabledInput.disabled = busy;
  whatsappEnabled.disabled = busy;
  whatsappSender.disabled = busy;
  whatsappSendFirst.disabled = busy;
  whatsappSendUnchanged.disabled = busy;
  whatsappSender.required = whatsappEnabled.checked;
  whatsappStatusButton.disabled = busy || dirty;
  whatsappTestButton.disabled = busy || dirty || !currentData?.config?.whatsapp?.enabled;
  whatsappTestRecipientsButton.disabled = whatsappTestButton.disabled;
  updateScheduleControls();
  checkButton.disabled = busy || !ready || dirty || Boolean(pending);
  checkButton.textContent = pending ? (currentData?.state?.pending?.waitingForVerification ? t("btn_wait_verif") : t("btn_checking")) : t("opt_check_now");
  if (dirty) $("check-help").textContent = t("opt_help_dirty");
  else if (!ready) $("check-help").textContent = t("opt_help_not_ready");
  else if (pending) $("check-help").textContent = currentData?.state?.pending?.waitingForVerification
    ? t("opt_help_verif")
    : t("opt_help_pending");
  else $("check-help").textContent = t("opt_help_ready");
  for (const id of slots) {
    numberInput(id).disabled = busy;
    pinInput(id).disabled = busy;
    phonesInput(id).disabled = busy;
    groupsInput(id).disabled = busy;
    const existing = accounts.find((account) => account.id === id);
    const kept = existing?.hasPin && existing.applicationNumber === numberInput(id).value.trim();
    $(`pin-help-${id}`).textContent = kept
      ? t("opt_pin_kept")
      : t("opt_pin_new_long");
  }
}
function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}
function whatsappError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return typeof error.message === "string" ? error.message : t("wa_check_conn");
}
function renderWhatsapp() {
  const config = currentData?.config?.whatsapp || {};
  const state = currentData?.state?.whatsapp || {};
  const status = $("whatsapp-status");
  status.classList.remove("error");
  if (lastWhatsappStatus) {
    const connected = Boolean(lastWhatsappStatus.connected);
    const senderMatches = Boolean(lastWhatsappStatus.senderMatches);
    const sender = lastWhatsappStatus.senderMasked ? ` (${lastWhatsappStatus.senderMasked})` : "";
    status.textContent = !connected
      ? t("wa_st_not_connected")
      : !config.senderPhone ? t("wa_st_no_sender", { sender })
      : !senderMatches ? t("wa_st_mismatch", { sender })
      : t("wa_st_ok", { sender });
    const error = whatsappError(lastWhatsappStatus.lastError);
    if (error) status.textContent += ` ${error}`;
    status.classList.toggle("error", !connected || (Boolean(config.senderPhone) && !senderMatches) || Boolean(error));
  } else status.textContent = config.enabled
    ? t("wa_st_on")
    : t("wa_st_off");
  const groupMatches = Array.isArray(lastWhatsappStatus?.groupMatches) ? lastWhatsappStatus.groupMatches : [];
  const groupLines = groupMatches.map((group) => {
    const count = Number(group.count);
    return `${group.name}: ${count === 1 ? t("wa_grp_found") : count === 0 ? t("wa_grp_none") : t("wa_grp_many")}.`;
  });
  $("whatsapp-groups").textContent = groupLines.join("\n");
  $("whatsapp-groups").hidden = groupLines.length === 0;
  $("whatsapp-groups").classList.toggle("error", groupMatches.some((group) => Number(group.count) !== 1));
  const pending = Number.isFinite(Number(state.pendingCount)) ? Math.max(0, Number(state.pendingCount)) : 0;
  const error = whatsappError(state.lastError);
  const delivery = $("whatsapp-delivery");
  const parts = [];
  if (pending) parts.push(t("opt_wa_waiting", { n: pending }));
  if (state.lastSentAt) parts.push(t("wa_last_sent", { date: dateText(state.lastSentAt) }));
  if (error) parts.push(error);
  delivery.textContent = parts.join(" ");
  delivery.hidden = parts.length === 0;
  delivery.classList.toggle("error", Boolean(error));
}
function render(data) {
  currentData = data;
  const config = data.config || {};
  const state = data.state || {};
  const accounts = savedAccounts();
  if (!initialised) {
    for (const id of slots) {
      const account = accounts.find((item) => item.id === id);
      numberInput(id).value = account?.applicationNumber || "";
      phonesInput(id).value = Array.isArray(account?.whatsappRecipients?.phones) ? account.whatsappRecipients.phones.join("\n") : "";
      groupsInput(id).value = Array.isArray(account?.whatsappRecipients?.groups) ? account.whatsappRecipients.groups.join("\n") : "";
    }
    enabledInput.checked = config.enabled !== false;
    const schedule = { ...defaultSchedule, ...config.schedule };
    $("schedule-mode").value = schedule.mode;
    $("schedule-monthday").value = String(schedule.monthDay);
    $("schedule-weekday").value = String(schedule.weekDay);
    $("schedule-days").value = String(schedule.days);
    $("schedule-time").value = schedule.time;
    whatsappEnabled.checked = Boolean(config.whatsapp?.enabled);
    whatsappSendFirst.checked = Boolean(config.whatsapp?.sendFirst);
    whatsappSendUnchanged.checked = Boolean(config.whatsapp?.sendUnchanged);
    whatsappSender.value = config.whatsapp?.senderPhone || "";
    initialised = true;
  }
  const pending = Boolean(state.pending || state.batch);
  const error = plainError(state.lastError);
  const ready = accounts.length > 0 && accounts.every((account) => account.hasPin);
  const badge = $("activity");
  badge.textContent = pending ? (state.pending?.waitingForVerification ? t("tracking_wait_verif") : t("tracking_checking")) : error ? t("needs_attention") : !ready ? t("tracking_setup") : config.enabled ? t("tracking_on") : t("tracking_paused");
  badge.classList.toggle("warning", Boolean(error) || !ready);
  $("result-message").textContent = pending
    ? t("opt_checking_seq")
    : accounts.length ? (accounts.length === 1 ? t("opt_tracking_one") : t("opt_tracking_many", { n: accounts.length })) : t("opt_save_apps");
  $("last-error").textContent = error;
  $("last-error").hidden = !error;
  $("last-success").textContent = dateText(state.lastSuccessAt);
  $("next-due").textContent = config.enabled === false ? t("tracking_paused") : !ready ? t("opt_after_save") : state.nextDueAt ? t("opt_with_tz", { date: dateText(state.nextDueAt) }) : scheduleText(config.schedule);
  $("notification-status").textContent = data.notificationPermission === "granted"
    ? t("opt_notif_granted")
    : data.notificationPermission === "denied"
      ? t("opt_notif_denied")
      : t("opt_notif_unknown");
  renderWhatsapp();

  $("account-results").replaceChildren();
  for (const account of accounts) {
    const result = state.results?.[account.id] || {};
    const status = typeof result.lastStatus === "string" ? result.lastStatus : "";
    const section = element("section", "account-result");
    section.append(element("h3", "", account.applicationNumber));
    section.append(element("p", "result-message", status ? translateKnownStatus(status) : t("no_success_yet")));
    if (status) section.append(element("p", "official-status", status));
    section.append(element("p", "field-help", t("opt_last_success_at", { date: dateText(result.lastSuccessAt) })));
    const accountError = plainError(result.lastError);
    if (accountError) section.append(element("p", "error-box", accountError));
    $("account-results").append(section);
  }
  const history = Array.isArray(state.history) ? state.history.slice(0, 6) : [];
  $("history").replaceChildren();
  $("empty-history").hidden = history.length > 0;
  for (const item of history) {
    const li = element("li");
    const meta = element("div", "history-meta");
    meta.append(element("time", "", dateText(item.at)));
    meta.append(element("span", item.changed ? "change" : "", `${item.applicationNumber || t("hist_app")} · ${item.changed ? t("hist_changed") : t("hist_checked")}`));
    li.append(meta, element("p", "", typeof item.status === "string" ? item.status : ""));
    $("history").append(li);
  }
  setButtons();
}
async function refresh() {
  if (refreshInProgress) { refreshAgain = true; return; }
  refreshInProgress = true;
  try {
    const data = await request({ type: "ui-state" });
    applyLanguage(data.config?.language);
    render(data);
  }
  catch (error) { feedback(error.message || t("opt_load_failed"), true); }
  finally {
    refreshInProgress = false;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}
async function perform(message, successMessage) {
  if (busy) return false;
  busy = true;
  setButtons();
  feedback("");
  try {
    await request(message);
    feedback(successMessage);
    return true;
  } catch (error) {
    feedback(error.message || t("opt_failed"), true);
    return false;
  } finally {
    busy = false;
    await refresh();
    setButtons();
  }
}
form.addEventListener("input", () => { dirty = true; lastWhatsappStatus = null; setButtons(); });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || currentData?.state?.pending || currentData?.state?.batch) {
    feedback(t("opt_wait_running"), true);
    return;
  }
  if (!form.reportValidity()) return;
  const accounts = [];
  for (const id of slots) {
    const applicationNumber = numberInput(id).value.trim();
    const pin = pinInput(id).value;
    if (!applicationNumber && pin) {
      feedback(t("opt_row_needs_number", { n: id }), true);
      numberInput(id).focus();
      return;
    }
    if (applicationNumber) accounts.push({
      id, applicationNumber, pin,
      whatsappRecipients: {
        phones: phonesInput(id).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean),
        groups: groupsInput(id).value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)
      }
    });
  }
  if (accounts.length === 0) { feedback(t("opt_need_one"), true); return; }
  if (new Set(accounts.map((account) => account.applicationNumber)).size !== accounts.length) {
    feedback(t("opt_dup"), true);
    return;
  }
  for (const account of accounts) {
    const previous = savedAccounts().find((saved) => saved.id === account.id && saved.applicationNumber === account.applicationNumber);
    if (!account.pin && !previous?.hasPin) {
      feedback(t("opt_need_pin", { n: account.id }), true);
      pinInput(account.id).focus();
      return;
    }
  }
  const schedule = {
    mode: $("schedule-mode").value,
    monthDay: Number($("schedule-monthday").value),
    weekDay: Number($("schedule-weekday").value),
    days: Number($("schedule-days").value),
    time: $("schedule-time").value
  };
  const whatsapp = { enabled: whatsappEnabled.checked, senderPhone: whatsappSender.value.trim(),
    sendFirst: whatsappSendFirst.checked, sendUnchanged: whatsappSendUnchanged.checked };
  if (whatsapp.enabled && !whatsapp.senderPhone) {
    feedback(t("opt_need_sender"), true);
    whatsappSender.focus();
    return;
  }
  // Request directly in the submit gesture; no asynchronous work may precede it.
  let whatsappPermission;
  if (whatsapp.enabled && !currentData?.config?.whatsapp?.enabled) {
    try { whatsappPermission = chrome.permissions.request({ origins: ["https://web.whatsapp.com/*"] }); }
    catch { feedback(t("opt_perm_req_failed_save"), true); return; }
  }
  if (whatsappPermission) {
    busy = true;
    setButtons();
    let granted = false;
    try { granted = await whatsappPermission; }
    catch { feedback(t("opt_perm_browser_failed"), true); }
    finally { busy = false; setButtons(); }
    if (!granted) {
      feedback(t("opt_perm_denied_save"), true);
      return;
    }
  }
  const saved = await perform({ type: "save-config", accounts, enabled: enabledInput.checked, schedule, whatsapp }, t("opt_saved"));
  if (saved) { for (const id of slots) pinInput(id).value = ""; lastWhatsappStatus = null; dirty = false; renderWhatsapp(); setButtons(); }
});
checkButton.addEventListener("click", () => {
  void perform({ type: "check-now" }, t("opt_check_started"));
});
testButton.addEventListener("click", () => {
  void perform({ type: "notification-test" }, t("opt_notif_sent"));
});
whatsappStatusButton.addEventListener("click", async () => {
  if (busy || dirty) return;
  let whatsappPermission;
  try { whatsappPermission = chrome.permissions.request({ origins: ["https://web.whatsapp.com/*"] }); }
  catch { $("whatsapp-status").textContent = t("opt_perm_req_failed"); $("whatsapp-status").classList.add("error"); return; }
  busy = true;
  setButtons();
  $("whatsapp-status").textContent = t("opt_wa_checking");
  try {
    if (!await whatsappPermission) {
      $("whatsapp-status").textContent = t("opt_perm_denied_check");
      $("whatsapp-status").classList.add("error");
      return;
    }
    const response = await request({ type: "whatsapp-status" });
    lastWhatsappStatus = response.status || {};
    renderWhatsapp();
  } catch (error) {
    $("whatsapp-status").textContent = error.message || t("opt_wa_check_failed");
    $("whatsapp-status").classList.add("error");
  } finally { busy = false; setButtons(); }
});
async function whatsappTest(target) {
  if (busy || dirty) return;
  if (!currentData?.config?.whatsapp?.enabled) { feedback(t("opt_wa_enable_first"), true); return; }
  let whatsappPermission;
  try { whatsappPermission = chrome.permissions.request({ origins: ["https://web.whatsapp.com/*"] }); }
  catch { feedback(t("opt_perm_req_failed"), true); return; }
  busy = true;
  setButtons();
  feedback(t("opt_test_sending"));
  try {
    if (!await whatsappPermission) { feedback(t("opt_perm_denied_test"), true); return; }
    const response = await request({ type: "whatsapp-test", target });
    feedback(target === "recipients"
      ? t("opt_test_sent_rec", { n: response.sent || 0 })
      : t("opt_test_sent_self"));
  } catch (error) {
    feedback(error.message || t("opt_test_failed"), true);
  } finally { busy = false; setButtons(); }
}
whatsappTestButton.addEventListener("click", () => { void whatsappTest("self"); });
whatsappTestRecipientsButton.addEventListener("click", () => { void whatsappTest("recipients"); });
// Ayar yedeği (28 Eki): klasör taşırken ayarlar kaybolmasın. Eklentinin sakladığı HER ŞEY (bugün config + state:
// başvurular, PIN, WhatsApp ayarları, takvim, sonuçlar, geçmiş, gönderim kaydı) JSON dosyasına; yüklerken hepsi geri yazılır.
$("backup-save").addEventListener("click", async () => {
  const veri = await chrome.storage.local.get(null);
  if (!veri.config) { feedback(t("opt_backup_none"), true); return; }
  const blob = new Blob([JSON.stringify({ tur: "bulgaristan-ayar-yedek", surum: 2, zaman: new Date().toISOString(), veri }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bulgaristan-ayar-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  feedback(t("opt_backup_done"));
});
$("backup-load").addEventListener("click", () => { $("backup-file").value = ""; $("backup-file").click(); });
$("backup-file").addEventListener("change", async () => {
  const file = $("backup-file").files[0];
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { feedback(t("opt_backup_bad_file"), true); return; }
  const veri = data && data.tur === "bulgaristan-ayar-yedek" ? (data.veri || { config: data.config, state: data.state }) : null;
  if (!veri || !veri.config || typeof veri.config !== "object") { feedback(t("opt_backup_wrong"), true); return; }
  await chrome.storage.local.clear();                      // yeni eklentinin boş başlangıcı yerine yedekteki her şey
  await chrome.storage.local.set(Object.fromEntries(Object.entries(veri).filter(([, v]) => v != null)));
  feedback(t("opt_backup_loaded"));
  setTimeout(() => chrome.runtime.reload(), 800);   // arka plan takvimi yeni ayarla yeniden kurar
});
// Dil secimi formun disinda: degistirmek kaydedilmemis basvuru bilgilerini etkilemez, hemen uygulanir.
$("language").addEventListener("change", async () => {
  applyLanguage($("language").value);
  if (currentData) render(currentData);
  try { await request({ type: "set-language", language: aktifDil() }); }
  catch (error) { feedback(error.message || t("opt_failed"), true); }
});
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refresh(); });
window.addEventListener("focus", () => { void refresh(); });
await refresh();
void request({ type: "mark-read" }).catch(() => {});
