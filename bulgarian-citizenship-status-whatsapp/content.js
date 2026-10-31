// Wait for the official page's ordinary verification and rendering. Never solve or click a challenge.
(() => {
  const EXPECTED = 'https://publicbg.mjs.bg/BgInfo/Home/Enroll';
  const GUARD = '__bgMonthlyEnrollmentContentV2';
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const POLL_MS = 500;
  if (window.top !== window || globalThis[GUARD]) return;

  function route() {
    if (location.origin + location.pathname !== EXPECTED) return 'invalid';
    if (!location.search) return 'canonical';
    const names = [...new URLSearchParams(location.search).keys()];
    return names.length && names.every((name) => name.startsWith('__cf_chl')) ? 'verification' : 'invalid';
  }
  if (route() === 'invalid') return;
  const lifecycle = {active: true};
  globalThis[GUARD] = lifecycle;
  const stopAt = Date.now() + MAX_WAIT_MS;
  let waitingReported = false;
  let cleanRequested = false;
  let submissionRequested = false;
  let submissionClaimed = false;
  let resultReported = false;
  let running = false;
  let rerun = false;
  let timer = null;
  let observer = null;
  const send = (message) => chrome.runtime.sendMessage(message);

  function stop() {
    lifecycle.active = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer?.disconnect();
  }

  async function freshJob() {
    const response = await send({type: 'page-job'});
    if (!lifecycle.active) return null;
    const job = response?.job;
    if (!job) { if (response?.ok !== false) stop(); return null; }
    if (Number.isFinite(job.deadline) && Date.now() > job.deadline) { stop(); return null; }
    return job;
  }

  function visible(element) {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse' && element.getClientRects().length > 0;
  }

  function challengeVisible() {
    if (/just a moment|attention required/i.test(document.title)) return true;
    return [...document.querySelectorAll(
      '#challenge-running, #challenge-stage, #cf-challenge-running, .cf-turnstile, '
      + 'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
    )].some(visible);
  }

  function readyForm() {
    for (const form of document.forms) {
      try {
        if (new URL(form.action, location.href).href !== EXPECTED
            || form.method.toLowerCase() !== 'post'
            || (form.target && form.target !== '_self') || form.isConnected === false) continue;
        const number = form.querySelector('input[name="reqNum"]');
        const pin = form.querySelector('input[name="pin"]');
        const submit = form.querySelector('button[type="submit"], input[type="submit"]');
        const token = form.querySelector('input[name="__RequestVerificationToken"]');
        if (!number || !pin || !submit || !token || !String(token.value || '').trim()
            || number.form !== form || pin.form !== form || submit.form !== form
            || number.disabled || pin.disabled || submit.disabled
            || number.isConnected === false || pin.isConnected === false || submit.isConnected === false
            || submit.hasAttribute('formaction') || submit.hasAttribute('formmethod')
            || submit.hasAttribute('formtarget') || typeof form.requestSubmit !== 'function') continue;
        return {form, number, pin, submit};
      } catch {}
    }
    return null;
  }

  function messages() {
    return [...document.querySelectorAll('.validation-summary-errors li, .validation-summary-valid li')]
      .map((item) => item.textContent).filter((text) => typeof text === 'string' && text.trim());
  }

  function newResultDocument(job) {
    return !submissionClaimed && job.isSubmissionDocument === false;
  }

  async function reportWaiting() {
    if (waitingReported) return;
    const job = await freshJob();
    if (!job || (route() !== 'verification' && !challengeVisible())) return;
    waitingReported = true;
    await send({type: 'page-wait', jobId: job.id, reason: 'verification'});
  }

  async function step() {
    if (Date.now() >= stopAt || route() === 'invalid') { stop(); return; }
    const job = await freshJob();
    if (!job) return;
    if (challengeVisible()) { await reportWaiting(); return; }
    const currentRoute = route();
    if (currentRoute === 'invalid') { stop(); return; }

    if (job.phase === 'submitted') {
      // Reading an actual new-document result is safe even if Cloudflare left its own query token.
      // A submitted job is never cleaned, navigated, or submitted again.
      if (!messages().length) {
        if (currentRoute === 'verification') await reportWaiting();
        return;
      }
      if (resultReported || !newResultDocument(job)) return;
      const current = await freshJob();
      if (!current || current.id !== job.id || current.phase !== 'submitted'
          || !newResultDocument(current) || route() === 'invalid' || challengeVisible()) return;
      const latest = messages();
      if (!latest.length) return;
      resultReported = true;
      await send({type: 'page-result', jobId: current.id, messages: latest});
      return;
    }

    if (job.phase !== 'loading' || submissionRequested) return;
    const ready = readyForm();
    if (currentRoute === 'verification') {
      // Only the worker may perform one ordinary GET to the same canonical URL, before any POST.
      if (!ready) { await reportWaiting(); return; }
      if (cleanRequested || !job.canCleanVerificationUrl) return;
      const current = await freshJob();
      if (!current || current.id !== job.id || current.phase !== 'loading'
          || !current.canCleanVerificationUrl || route() !== 'verification'
          || challengeVisible() || !readyForm()) return;
      cleanRequested = true;
      const response = await send({type: 'page-clean-url', jobId: current.id});
      if (response?.ok && response.cleaned) stop();
      return;
    }

    if (currentRoute !== 'canonical' || !ready) return;
    const current = await freshJob();
    const beforeClaim = readyForm();
    if (!current || current.id !== job.id || current.phase !== 'loading'
        || route() !== 'canonical' || challengeVisible() || !beforeClaim) return;
    // Claim at most once in this document, even if the reply is interrupted.
    submissionRequested = true;
    const credentials = await send({type: 'page-submit', jobId: current.id});
    if (!credentials?.ok) return;
    submissionClaimed = true;
    if (route() === 'verification' || challengeVisible()) { await reportWaiting(); return; }
    const beforeFill = readyForm();
    if (route() !== 'canonical' || !beforeFill || beforeFill.form !== beforeClaim.form) return;
    beforeFill.number.value = credentials.applicationNumber;
    beforeFill.pin.value = credentials.pin;
    for (const input of [beforeFill.number, beforeFill.pin]) {
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }
    const beforeSubmit = await freshJob();
    if (!beforeSubmit || beforeSubmit.id !== current.id || beforeSubmit.phase !== 'submitted') return;
    if (route() === 'verification' || challengeVisible()) { await reportWaiting(); return; }
    const final = readyForm();
    if (route() !== 'canonical' || !final || final.form !== beforeFill.form
        || final.number !== beforeFill.number || final.pin !== beforeFill.pin
        || final.submit !== beforeFill.submit) return;
    try { final.form.requestSubmit(final.submit); }
    catch {
      const latest = await freshJob();
      if (latest && latest.id === current.id && route() === 'canonical') {
        await send({type: 'page-error', jobId: latest.id, code: 'submit'});
      }
    }
  }

  function schedule(delay = POLL_MS) {
    if (!lifecycle.active) return;
    if (running) { rerun = true; return; }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, Math.min(delay, Math.max(0, stopAt - Date.now())));
  }

  async function run() {
    timer = null;
    if (!lifecycle.active || running) return;
    running = true;
    rerun = false;
    try { await step(); }
    catch {
      // Temporary rendering/messaging problems are handled by polling and the worker deadline.
    } finally {
      running = false;
      if (lifecycle.active) schedule(rerun ? 0 : POLL_MS);
    }
  }

  observer = new MutationObserver(() => schedule(0));
  observer.observe(document, {childList: true, subtree: true, attributes: true, characterData: true});
  schedule(0);
})();
