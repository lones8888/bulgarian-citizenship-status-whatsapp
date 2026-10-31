const $ = (id) => document.getElementById(id);
const checkButton = $("check");
let currentData = null;
let busy = false;
let refreshing = false;
let refreshAgain = false;
const dates = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short" });

function dateText(value) {
  if (!value) return "Henüz yapılmadı";
  const date = new Date(value);
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
  return typeof error.message === "string" ? error.message : "Son sorgu tamamlanamadı. Kontrol için Ayarlar’ı aç.";
}
function feedback(text, error = false) {
  $("feedback").textContent = text;
  $("feedback").classList.toggle("error", error);
}
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Eklenti bilgileri alınamadı. Yeniden açmayı dene.");
  return response;
}
function setButtons() {
  const accounts = currentData?.config?.accounts || [];
  const pending = Boolean(currentData?.state?.pending || currentData?.state?.batch);
  const ready = accounts.length > 0 && accounts.every((account) => account.hasPin);
  checkButton.disabled = busy || pending || !ready;
  checkButton.textContent = pending ? (currentData?.state?.pending?.waitingForVerification ? "Doğrulama bekleniyor…" : "Kontrol sürüyor…") : "Tümünü kontrol et";
  $("footer-note").textContent = pending ? (currentData?.state?.pending?.waitingForVerification ? "Doğrulama bitince devam edecek. Sorgu sekmesini açık tut." : "Açılan sorgu sekmesini açık tut.") : "Sonuçlar resmî sorgu sitesinden alınır.";
}
function appendOfficialDetails(section, official) {
  const details = element("details");
  details.append(element("summary", "", "Resmî metnin tamamı"), element("p", "", official));
  section.append(details);
}
function render(data) {
  currentData = data;
  const config = data.config || {};
  const state = data.state || {};
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];
  const pending = Boolean(state.pending || state.batch);
  const ready = accounts.length > 0 && accounts.every((account) => account.hasPin);
  $("account-count").textContent = `${accounts.length} başvuru`;
  $("tracking").textContent = pending ? (state.pending?.waitingForVerification ? "Doğrulama bekleniyor" : "Kontrol ediliyor") : !ready ? "Kurulum gerekli" : config.enabled ? "Otomatik takip açık" : "Takip duraklatıldı";
  $("tracking").classList.toggle("paused", !ready || !config.enabled);
  $("next-due").textContent = config.enabled === false ? "Takip duraklatıldı" : !ready ? "Ayarlar’dan başvuru ekle" : state.nextDueAt ? dateText(state.nextDueAt) : "Takvim ayarlanıyor…";
  $("empty-state").hidden = accounts.length > 0;
  const globalError = errorText(state.lastError);
  $("last-error").hidden = !globalError;
  $("last-error").textContent = globalError;
  const whatsapp = state.whatsapp || {};
  const whatsappPending = Number.isFinite(Number(whatsapp.pendingCount)) ? Math.max(0, Number(whatsapp.pendingCount)) : 0;
  const whatsappError = typeof whatsapp.lastError === "string" ? whatsapp.lastError : typeof whatsapp.lastError?.message === "string" ? whatsapp.lastError.message : "";
  const whatsappParts = [];
  if (whatsappPending) whatsappParts.push(`WhatsApp gönderimi bekliyor: ${whatsappPending}.`);
  if (whatsapp.lastSentAt) whatsappParts.push(`WhatsApp’ta son gönderim: ${dateText(whatsapp.lastSentAt)}.`);
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
    heading.append(element("span", `status-label${error ? " warning" : ""}`, error ? "Kontrol gerekli" : status ? "Son sonuç" : "Bekliyor"));
    section.append(heading);
    const known = status.includes("Преписката се намира в процедура по задължително съгласуване.");
    if (known) {
      section.append(element("p", "status-text", "Dosya zorunlu koordinasyon prosedüründedir."));
      appendOfficialDetails(section, status);
    } else if (status) {
      section.append(element("p", "status-text", status.length > 180 ? `${status.slice(0, 170)}…` : status));
      if (status.length > 180) appendOfficialDetails(section, status);
    } else {
      section.append(element("p", "status-text unqueried", "Henüz başarılı sorgu yapılmadı."));
    }
    section.append(element("p", "checked-at", `Son sorgu: ${dateText(result.lastSuccessAt)}`));
    if (error) section.append(element("p", "account-error", error));
    $("accounts").append(section);
  }
  setButtons();
}
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try { render(await request({ type: "ui-state" })); }
  catch (error) { feedback(error.message || "Sonuçlar yüklenemedi.", true); }
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
    feedback("Kontrol başlatıldı. Sonuçlar burada güncellenecek.");
  } catch (error) { feedback(error.message || "Kontrol başlatılamadı.", true); }
  finally { busy = false; await refresh(); setButtons(); }
});
$("settings").addEventListener("click", async () => {
  try { await chrome.runtime.openOptionsPage(); window.close(); }
  catch { feedback("Ayarlar açılamadı. Eklenti yönetiminden Seçenekler’i açabilirsin.", true); }
});
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refresh(); });
window.addEventListener("focus", () => { void refresh(); });
await refresh();
void request({ type: "mark-read" }).catch(() => {});
