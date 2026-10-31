import { t, dilAyarla, aktifDil, yerel, sayfayiCevir } from "./i18n.mjs";
import { durumCevirisi } from "./core.mjs";

const $ = (id) => document.getElementById(id);
const checkButton = $("check");
let currentData = null;
let busy = false;
let refreshing = false;
let refreshAgain = false;
const dateFormats = {};

function dateText(value) {
  if (!value) return t("not_yet");
  const date = new Date(value);
  const dates = dateFormats[aktifDil()] ||= new Intl.DateTimeFormat(yerel(), { timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short" });
  return Number.isFinite(date.getTime()) ? dates.format(date) : "—";
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return typeof error.message === "string" ? error.message : t("pop_last_failed");
}
function feedback(text, error = false) {
  $("feedback").textContent = text;
  $("feedback").classList.toggle("error", error);
}
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || t("pop_load_failed_ext"));
  return response;
}
// Dil: sayfadaki sabit yazilar data-i18n ile, degisen yazilar render() ile secili dile gecer.
function applyLanguage(language) {
  dilAyarla(language);
  sayfayiCevir();
  for (const button of document.querySelectorAll(".lang-switch button")) {
    button.setAttribute("aria-pressed", String(button.dataset.dil === aktifDil()));
  }
}
function setButtons() {
  const accounts = currentData?.config?.accounts || [];
  const pending = Boolean(currentData?.state?.pending || currentData?.state?.batch);
  const ready = accounts.length > 0 && accounts.every((account) => account.hasPin);
  checkButton.disabled = busy || pending || !ready;
  checkButton.textContent = pending ? (currentData?.state?.pending?.waitingForVerification ? t("btn_wait_verif") : t("btn_checking")) : t("pop_check_all");
  $("footer-note").textContent = pending ? (currentData?.state?.pending?.waitingForVerification ? t("pop_footer_verif") : t("pop_footer_keep_tab")) : t("footer_results");
}
function appendOfficialDetails(section, official) {
  const details = element("details");
  details.append(element("summary", "", t("pop_full_text")), element("p", "", official));
  section.append(details);
}
function render(data) {
  currentData = data;
  const config = data.config || {};
  const state = data.state || {};
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];
  const pending = Boolean(state.pending || state.batch);
  const ready = accounts.length > 0 && accounts.every((account) => account.hasPin);
  $("account-count").textContent = accounts.length === 1 ? t("count_one") : t("count_many", { n: accounts.length });
  $("tracking").textContent = pending ? (state.pending?.waitingForVerification ? t("tracking_wait_verif") : t("tracking_checking")) : !ready ? t("tracking_setup") : config.enabled ? t("tracking_on") : t("tracking_paused");
  $("tracking").classList.toggle("paused", !ready || !config.enabled);
  $("next-due").textContent = config.enabled === false ? t("tracking_paused") : !ready ? t("pop_add_in_settings") : state.nextDueAt ? dateText(state.nextDueAt) : t("pop_schedule_setting");
  $("empty-state").hidden = accounts.length > 0;
  const globalError = errorText(state.lastError);
  $("last-error").hidden = !globalError;
  $("last-error").textContent = globalError;
  const whatsapp = state.whatsapp || {};
  const whatsappPending = Number.isFinite(Number(whatsapp.pendingCount)) ? Math.max(0, Number(whatsapp.pendingCount)) : 0;
  const whatsappError = typeof whatsapp.lastError === "string" ? whatsapp.lastError : typeof whatsapp.lastError?.message === "string" ? whatsapp.lastError.message : "";
  const whatsappParts = [];
  if (whatsappPending) whatsappParts.push(t("pop_wa_waiting", { n: whatsappPending }));
  if (whatsapp.lastSentAt) whatsappParts.push(t("wa_last_sent", { date: dateText(whatsapp.lastSentAt) }));
  if (whatsappError) whatsappParts.push(whatsappError);
  $("whatsapp-delivery").textContent = whatsappParts.join(" ");
  $("whatsapp-delivery").hidden = whatsappParts.length === 0;
  $("whatsapp-delivery").classList.toggle("error", Boolean(whatsappError));
  $("accounts").replaceChildren();
  for (const account of accounts) {
    const result = state.results?.[account.id] || {};
    const status = typeof result.lastStatus === "string" ? result.lastStatus : "";
    const error = errorText(result.lastError);
    const section = element("article", "account");
    const heading = element("div", "account-heading");
    heading.append(element("h2", "", account.applicationNumber));
    heading.append(element("span", `status-label${error ? " warning" : ""}`, error ? t("needs_attention") : status ? t("pop_latest") : t("pop_waiting")));
    section.append(heading);
    const translated = status ? durumCevirisi(status) : "";
    if (translated) {
      section.append(element("p", "status-text", translated));
      appendOfficialDetails(section, status);
    } else if (status) {
      section.append(element("p", "status-text", status.length > 180 ? `${status.slice(0, 170)}…` : status));
      if (status.length > 180) appendOfficialDetails(section, status);
    } else {
      section.append(element("p", "status-text unqueried", t("no_success_yet")));
    }
    section.append(element("p", "checked-at", t("pop_last_check", { date: dateText(result.lastSuccessAt) })));
    if (error) section.append(element("p", "account-error", error));
    $("accounts").append(section);
  }
  setButtons();
}
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const data = await request({ type: "ui-state" });
    applyLanguage(data.config?.language);
    render(data);
  }
  catch (error) { feedback(error.message || t("pop_results_failed"), true); }
  finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}
checkButton.addEventListener("click", async () => {
  if (busy || currentData?.state?.pending || currentData?.state?.batch) return;
  busy = true;
  setButtons();
  feedback("");
  try {
    await request({ type: "check-now" });
    feedback(t("pop_check_started"));
  } catch (error) { feedback(error.message || t("pop_check_failed"), true); }
  finally { busy = false; await refresh(); setButtons(); }
});
$("settings").addEventListener("click", async () => {
  try { await chrome.runtime.openOptionsPage(); window.close(); }
  catch { feedback(t("pop_settings_failed"), true); }
});
for (const button of document.querySelectorAll(".lang-switch button")) {
  button.addEventListener("click", async () => {
    if (button.dataset.dil === aktifDil()) return;
    applyLanguage(button.dataset.dil);
    if (currentData) render(currentData);
    try { await request({ type: "set-language", language: aktifDil() }); }
    catch (error) { feedback(error.message || t("pop_load_failed_ext"), true); }
  });
}
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refresh(); });
window.addEventListener("focus", () => { void refresh(); });
await refresh();
void request({ type: "mark-read" }).catch(() => {});
