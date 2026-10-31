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

const formatter = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short"
});
function dateText(value) {
  if (!value) return "Henüz yapılmadı";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? formatter.format(parsed) : "—";
}
function feedback(message, isError = false) {
  $("feedback").textContent = message;
  $("feedback").classList.toggle("error", isError);
}
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "İşlem tamamlanamadı. Eklentiyi yeniden açmayı dene.");
  return response;
}
function plainError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return "Son sorgu tamamlanamadı. Resmî siteyi açarak kontrol et.";
}
function translateKnownStatus(status) {
  if (status.includes("Преписката се намира в процедура по задължително съгласуване.")) {
    return "Dosya zorunlu koordinasyon prosedüründedir.";
  }
  return "Güncel resmî sonuç aşağıda.";
}
function savedAccounts() {
  return Array.isArray(currentData?.config?.accounts) ? currentData.config.accounts : [];
}
function scheduleText(schedule = defaultSchedule) {
  const s = { ...defaultSchedule, ...schedule };
  const weekdays = ["pazar", "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi"];
  if (s.mode === "weekly") return `Her ${weekdays[s.weekDay]}, ${s.time} (TR)`;
  if (s.mode === "days") return `${s.days} günde bir, ${s.time} (TR)`;
  return `Her ayın ${s.monthDay}. günü, ${s.time} (TR)`;
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
  checkButton.textContent = pending ? (currentData?.state?.pending?.waitingForVerification ? "Doğrulama bekleniyor…" : "Kontrol sürüyor…") : "Tümünü şimdi kontrol et";
  if (dirty) $("check-help").textContent = "Yeni bilgileri kullanmak için önce kaydet.";
  else if (!ready) $("check-help").textContent = "Başvuru numaralarını ve PIN’lerini kaydet, ardından tümünü kontrol et.";
  else if (pending) $("check-help").textContent = currentData?.state?.pending?.waitingForVerification
    ? "Site doğrulaması bekleniyor. Açık sorgu sekmesini kapatma; elle onay istenirse tamamla. Doğrulama bitince kontrol kendisi devam eder."
    : "Sorgu için açılan tarayıcı sekmesini kontrol tamamlanana kadar açık tut. Başvurular sırayla sorgulanır.";
  else $("check-help").textContent = "Kayıtlı başvuruları sırayla sorgular. Sonuçlar bu ekranda güncellenir.";
  for (const id of slots) {
    numberInput(id).disabled = busy;
    pinInput(id).disabled = busy;
    phonesInput(id).disabled = busy;
    groupsInput(id).disabled = busy;
    const existing = accounts.find((account) => account.id === id);
    const kept = existing?.hasPin && existing.applicationNumber === numberInput(id).value.trim();
    $(`pin-help-${id}`).textContent = kept
      ? "PIN kayıtlı. Değiştirmeyeceksen bu alanı boş bırak."
      : "Yeni başvuru için PIN gir. Kullanmayacaksan numarayı da boş bırak.";
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
  return typeof error.message === "string" ? error.message : "WhatsApp Web bağlantısını kontrol et.";
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
      ? "WhatsApp Web oturumu açık değil. Aynı tarayıcı profilinde WhatsApp Web’e giriş yap."
      : !config.senderPhone ? `WhatsApp Web bağlantısı açık${sender}. Gönderen numarasını girip ayarları kaydet.`
      : !senderMatches ? `WhatsApp Web bağlı${sender}, ancak açık hesap kayıtlı gönderen numarasıyla eşleşmiyor. Doğru hesapla giriş yap.`
      : `WhatsApp Web bağlantısı açık${sender}; gönderen hesabı doğrulandı. Bağlantı kontrolü mesaj göndermez.`;
    const error = whatsappError(lastWhatsappStatus.lastError);
    if (error) status.textContent += ` ${error}`;
    status.classList.toggle("error", !connected || (Boolean(config.senderPhone) && !senderMatches) || Boolean(error));
  } else status.textContent = config.enabled
    ? "WhatsApp Web bildirimi açık. Bağlantı kontrolü mesaj göndermeden oturumu doğrular."
    : "WhatsApp bildirimi kapalı. İstersen bağlantıyı mesaj göndermeden kontrol edebilirsin.";
  const groupMatches = Array.isArray(lastWhatsappStatus?.groupMatches) ? lastWhatsappStatus.groupMatches : [];
  const groupLines = groupMatches.map((group) => {
    const count = Number(group.count);
    return `${group.name}: ${count === 1 ? "grup bulundu" : count === 0 ? "grup bulunamadı" : "birden fazla eşleşme var; tam grup adını kontrol et"}.`;
  });
  $("whatsapp-groups").textContent = groupLines.join("\n");
  $("whatsapp-groups").hidden = groupLines.length === 0;
  $("whatsapp-groups").classList.toggle("error", groupMatches.some((group) => Number(group.count) !== 1));
  const pending = Number.isFinite(Number(state.pendingCount)) ? Math.max(0, Number(state.pendingCount)) : 0;
  const error = whatsappError(state.lastError);
  const delivery = $("whatsapp-delivery");
  const parts = [];
  if (pending) parts.push(`${pending} WhatsApp gönderimi bekliyor.`);
  if (state.lastSentAt) parts.push(`WhatsApp’ta son gönderim: ${dateText(state.lastSentAt)}.`);
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
  badge.textContent = pending ? (state.pending?.waitingForVerification ? "Doğrulama bekleniyor" : "Kontrol ediliyor") : error ? "Kontrol gerekli" : !ready ? "Kurulum gerekli" : config.enabled ? "Otomatik takip açık" : "Takip duraklatıldı";
  badge.classList.toggle("warning", Boolean(error) || !ready);
  $("result-message").textContent = pending
    ? "Başvurular sırayla kontrol ediliyor."
    : accounts.length ? `${accounts.length} başvuru takip ediliyor.` : "Takip etmek istediğin başvuruları kaydet.";
  $("last-error").textContent = error;
  $("last-error").hidden = !error;
  $("last-success").textContent = dateText(state.lastSuccessAt);
  $("next-due").textContent = config.enabled === false ? "Takip duraklatıldı" : !ready ? "Bilgiler kaydedildikten sonra" : state.nextDueAt ? `${dateText(state.nextDueAt)} (TR)` : scheduleText(config.schedule);
  $("notification-status").textContent = data.notificationPermission === "granted"
    ? "Tarayıcı bildirim izni açık."
    : data.notificationPermission === "denied"
      ? "Tarayıcı bildirim izni kapalı. Sonuçları bu ekrandan görebilirsin; Mac ayarlarından tarayıcı bildirimlerini açabilirsin."
      : "Bildirim izni doğrulanamadı. Test bildirimiyle kontrol edebilirsin.";
  renderWhatsapp();

  $("account-results").replaceChildren();
  for (const account of accounts) {
    const result = state.results?.[account.id] || {};
    const status = typeof result.lastStatus === "string" ? result.lastStatus : "";
    const section = element("section", "account-result");
    section.append(element("h3", "", account.applicationNumber));
    section.append(element("p", "result-message", status ? translateKnownStatus(status) : "Henüz başarılı sorgu yapılmadı."));
    if (status) section.append(element("p", "official-status", status));
    section.append(element("p", "field-help", `Son başarılı sorgu: ${dateText(result.lastSuccessAt)}`));
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
    meta.append(element("span", item.changed ? "change" : "", `${item.applicationNumber || "Başvuru"} · ${item.changed ? "Durum değişti" : "Kontrol edildi"}`));
    li.append(meta, element("p", "", typeof item.status === "string" ? item.status : ""));
    $("history").append(li);
  }
  setButtons();
}
async function refresh() {
  if (refreshInProgress) { refreshAgain = true; return; }
  refreshInProgress = true;
  try { render(await request({ type: "ui-state" })); }
  catch (error) { feedback(error.message || "Eklenti bilgileri yüklenemedi.", true); }
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
    feedback(error.message || "İşlem tamamlanamadı.", true);
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
    feedback("Bilgileri kaydetmeden önce devam eden kontrolün tamamlanmasını bekle.", true);
    return;
  }
  if (!form.reportValidity()) return;
  const accounts = [];
  for (const id of slots) {
    const applicationNumber = numberInput(id).value.trim();
    const pin = pinInput(id).value;
    if (!applicationNumber && pin) {
      feedback(`${id}. satırda PIN için başvuru numarası da gerekli.`, true);
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
  if (accounts.length === 0) { feedback("En az bir başvuru numarası ve PIN kaydet.", true); return; }
  if (new Set(accounts.map((account) => account.applicationNumber)).size !== accounts.length) {
    feedback("Aynı başvuru numarasını yalnızca bir kez gir.", true);
    return;
  }
  for (const account of accounts) {
    const previous = savedAccounts().find((saved) => saved.id === account.id && saved.applicationNumber === account.applicationNumber);
    if (!account.pin && !previous?.hasPin) {
      feedback(`${account.id}. başvuru için PIN gir.`, true);
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
    feedback("WhatsApp bildirimi için gönderen hesabın uluslararası numarasını gir.", true);
    whatsappSender.focus();
    return;
  }
  // Request directly in the submit gesture; no asynchronous work may precede it.
  let whatsappPermission;
  if (whatsapp.enabled && !currentData?.config?.whatsapp?.enabled) {
    try { whatsappPermission = chrome.permissions.request({ origins: ["https://web.whatsapp.com/*"] }); }
    catch { feedback("WhatsApp Web bağlantı izni istenemedi. WhatsApp ayarı kaydedilmedi.", true); return; }
  }
  if (whatsappPermission) {
    busy = true;
    setButtons();
    let granted = false;
    try { granted = await whatsappPermission; }
    catch { feedback("Tarayıcı WhatsApp Web bağlantı izni veremedi. WhatsApp ayarı kaydedilmedi.", true); }
    finally { busy = false; setButtons(); }
    if (!granted) {
      feedback("WhatsApp Web bağlantı izni verilmedi. WhatsApp bildirimi etkinleştirilmedi; ayarlar kaydedilmedi.", true);
      return;
    }
  }
  const saved = await perform({ type: "save-config", accounts, enabled: enabledInput.checked, schedule, whatsapp }, "Bilgiler ve takvim kaydedildi. İlk sonuçları almak için “Tümünü şimdi kontrol et”e basabilirsin.");
  if (saved) { for (const id of slots) pinInput(id).value = ""; lastWhatsappStatus = null; dirty = false; renderWhatsapp(); setButtons(); }
});
checkButton.addEventListener("click", () => {
  void perform({ type: "check-now" }, "Kontrol başlatıldı. Açılan sorgu sekmesini kontroller tamamlanana kadar açık tut.");
});
testButton.addEventListener("click", () => {
  void perform({ type: "notification-test" }, "Test bildirimi gönderildi. Görünmüyorsa Mac’te tarayıcı bildirimlerini ve Odak modunu kontrol et.");
});
whatsappStatusButton.addEventListener("click", async () => {
  if (busy || dirty) return;
  let whatsappPermission;
  try { whatsappPermission = chrome.permissions.request({ origins: ["https://web.whatsapp.com/*"] }); }
  catch { $("whatsapp-status").textContent = "WhatsApp Web bağlantı izni istenemedi."; $("whatsapp-status").classList.add("error"); return; }
  busy = true;
  setButtons();
  $("whatsapp-status").textContent = "WhatsApp Web bağlantısı kontrol ediliyor…";
  try {
    if (!await whatsappPermission) {
      $("whatsapp-status").textContent = "WhatsApp Web bağlantı izni verilmedi; bağlantı kontrol edilmedi.";
      $("whatsapp-status").classList.add("error");
      return;
    }
    const response = await request({ type: "whatsapp-status" });
    lastWhatsappStatus = response.status || {};
    renderWhatsapp();
  } catch (error) {
    $("whatsapp-status").textContent = error.message || "WhatsApp Web bağlantısı kontrol edilemedi.";
    $("whatsapp-status").classList.add("error");
  } finally { busy = false; setButtons(); }
});
async function whatsappTest(target) {
  if (busy || dirty) return;
  if (!currentData?.config?.whatsapp?.enabled) { feedback("Önce WhatsApp bildirimini açıp kaydet.", true); return; }
  let whatsappPermission;
  try { whatsappPermission = chrome.permissions.request({ origins: ["https://web.whatsapp.com/*"] }); }
  catch { feedback("WhatsApp Web bağlantı izni istenemedi.", true); return; }
  busy = true;
  setButtons();
  feedback("Test mesajı gönderiliyor…");
  try {
    if (!await whatsappPermission) { feedback("WhatsApp Web bağlantı izni verilmedi; test mesajı gönderilmedi.", true); return; }
    const response = await request({ type: "whatsapp-test", target });
    feedback(target === "recipients"
      ? `Test mesajı ${response.sent || 0} alıcıya gönderildi. WhatsApp’ta kontrol et.`
      : "Test mesajı gönderildi. WhatsApp’ta kendi sohbetini (Kendime mesaj) kontrol et.");
  } catch (error) {
    feedback(error.message || "Test mesajı gönderilemedi.", true);
  } finally { busy = false; setButtons(); }
}
whatsappTestButton.addEventListener("click", () => { void whatsappTest("self"); });
whatsappTestRecipientsButton.addEventListener("click", () => { void whatsappTest("recipients"); });
// Ayar yedeği (28 Eki): klasör taşırken ayarlar kaybolmasın. Eklentinin sakladığı HER ŞEY (bugün config + state:
// başvurular, PIN, WhatsApp ayarları, takvim, sonuçlar, geçmiş, gönderim kaydı) JSON dosyasına; yüklerken hepsi geri yazılır.
$("backup-save").addEventListener("click", async () => {
  const veri = await chrome.storage.local.get(null);
  if (!veri.config) { feedback("Yedeklenecek ayar yok.", true); return; }
  const blob = new Blob([JSON.stringify({ tur: "bulgaristan-ayar-yedek", surum: 2, zaman: new Date().toISOString(), veri }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bulgaristan-ayar-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  feedback("Yedek İndirilenler’e indi. Yeni eklentide “Yedekten yükle” ile seç.");
});
$("backup-load").addEventListener("click", () => { $("backup-file").value = ""; $("backup-file").click(); });
$("backup-file").addEventListener("change", async () => {
  const file = $("backup-file").files[0];
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { feedback("Dosya okunamadı (yedek dosyası değil).", true); return; }
  const veri = data && data.tur === "bulgaristan-ayar-yedek" ? (data.veri || { config: data.config, state: data.state }) : null;
  if (!veri || !veri.config || typeof veri.config !== "object") { feedback("Bu bir Bulgaristan ayar yedeği değil.", true); return; }
  await chrome.storage.local.clear();                      // yeni eklentinin boş başlangıcı yerine yedekteki her şey
  await chrome.storage.local.set(Object.fromEntries(Object.entries(veri).filter(([, v]) => v != null)));
  feedback("Ayarlar yüklendi. Eklenti yeniden başlıyor…");
  setTimeout(() => chrome.runtime.reload(), 800);   // arka plan takvimi yeni ayarla yeniden kurar
});
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refresh(); });
window.addEventListener("focus", () => { void refresh(); });
await refresh();
void request({ type: "mark-read" }).catch(() => {});
