// Recorder screen — captures clicks from the embedded webview and builds step groups.

let recording    = false;
let paused       = false;
let steps        = []; // array of in-memory GROUP objects (not flat steps)
let webviewWcId  = null; // webContentsId of the webview, cached after first dom-ready

// ── Styled confirm dialog ──────────────────────────────────────────────────
// Returns a Promise resolving to true (OK) or false (Cancel).
// Uses the same modal markup as the editor and guides pages.
const confirmModalOverlay = document.getElementById('confirm-modal-overlay');
const confirmModalTitle   = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const btnConfirmCancel    = document.getElementById('btn-confirm-cancel');
const btnConfirmOk        = document.getElementById('btn-confirm-ok');

function showConfirm(message, { title = 'Confirm', okLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    confirmModalTitle.textContent   = title;
    confirmModalMessage.textContent = message;
    btnConfirmOk.textContent        = okLabel;
    btnConfirmCancel.textContent    = cancelLabel;
    confirmModalOverlay.removeAttribute('hidden');

    function cleanup() {
      confirmModalOverlay.setAttribute('hidden', '');
      btnConfirmOk.removeEventListener('click', onOk);
      btnConfirmCancel.removeEventListener('click', onCancel);
    }
    function onOk()     { cleanup(); resolve(true);  }
    function onCancel() { cleanup(); resolve(false); }

    btnConfirmOk.addEventListener('click', onOk);
    btnConfirmCancel.addEventListener('click', onCancel);
  });
}

const webview    = document.getElementById('target-view');

const btnStart          = document.getElementById('btn-start');
const btnPause          = document.getElementById('btn-pause');
const btnStop           = document.getElementById('btn-stop');
const recordingControls = document.getElementById('recording-controls');
const stepCountEl = document.getElementById('step-count');
const stepsList  = document.getElementById('steps-list');
const urlForm    = document.getElementById('url-form');
const urlInput   = document.getElementById('url-input');

// ── Webview message helper ──────────────────────────────────────────────────
// Route via main process (webview:relay IPC) rather than webview.send().
// webview.send() is async in Electron 28+ and can reject silently on timing issues;
// routing through main guarantees the message reaches the preload.

function sendToWebviewPreload(channel, ...args) {
  if (!window.flo) return;
  // webviewWcId is cached in dom-ready; fall back to reading it from the element
  // in case the user clicks Record before the first dom-ready fires.
  const wcId = webviewWcId ?? (webview ? webview.getWebContentsId() : null);
  if (!wcId) return;
  window.flo.sendToWebview(wcId, channel, ...args).catch(err =>
    console.error('[flo] sendToWebviewPreload error:', err)
  );
}

const urlPlaceholder = document.getElementById('url-placeholder');

// ── "My Flows" link → navigate to the flows list ───────────────────────────
// Guards against discarding unsaved captured steps before leaving.

document.getElementById('btn-logo').addEventListener('click', async (e) => {
  e.preventDefault();
  if (recording || paused || steps.length > 0) {
    const msg = steps.length > 0
      ? 'You have captured steps that haven\'t been saved. Leave anyway?'
      : 'You\'re currently recording. Leave anyway?';
    const ok = await showConfirm(msg,
      { title: 'Leave recording?', okLabel: 'Leave', cancelLabel: 'Keep recording' }
    );
    if (!ok) return;
  }
  if (recording || paused) {
    recording = false;
    paused    = false;
    sendToWebviewPreload('flo:stop-recording');
  }
  window.location.href = 'guides.html';
});

// ── URL navigation ─────────────────────────────────────────────────────────

urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  let url = urlInput.value.trim();
  if (!url) return;
  if (webview) {
    if (!/^(https?|file):\/\//i.test(url)) url = 'https://' + url;
    webview.src = url;
  }
});

// ── Welcome screen → Recorder transition ──────────────────────────────────────

const modeSwitcher = document.getElementById('mode-switcher');

function enterRecorderMode() {
  document.body.classList.remove('welcome-mode');
  modeSwitcher.removeAttribute('hidden');
  setTimeout(() => urlInput.focus(), 100);
}

// "Webpage" → enter recorder mode (URL entered via toolbar)
document.getElementById('btn-record-webapp').addEventListener('click', () => {
  enterRecorderMode();
});

// "Desktop App" → navigate to desktop recorder in window mode
document.getElementById('btn-record-desktop').addEventListener('click', () => {
  window.location.href = 'desktop.html?mode=window';
});

// "Full Monitor" → navigate to desktop recorder in screen mode
document.getElementById('btn-record-monitor').addEventListener('click', () => {
  window.location.href = 'desktop.html?mode=screen';
});

// Mode switcher — switch between the 3 recording modes from within the recorder
modeSwitcher.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mode-switcher-btn');
  if (!btn) return;
  const newMode = btn.dataset.mode;
  if (newMode === 'webpage') return; // already here

  if (recording || paused || steps.length > 0) {
    const ok = await showConfirm('Switching modes will discard any captured steps. Continue?', {
      title: 'Switch mode?', okLabel: 'Switch', cancelLabel: 'Stay'
    });
    if (!ok) return;
    if (recording || paused) {
      recording = false;
      paused    = false;
      sendToWebviewPreload('flo:stop-recording');
    }
    steps = [];
  }

  window.location.href = newMode === 'apps'
    ? 'desktop.html?mode=window'
    : 'desktop.html?mode=screen';
});

// If arriving via mode switcher from desktop recorder, skip welcome screen
if (new URLSearchParams(window.location.search).get('recorder') === '1') {
  enterRecorderMode();
}

// Hide URL placeholder when a real URL loads; show it when blank
if (webview) {
  webview.addEventListener('did-navigate', (e) => {
    const url = e.url || '';
    urlInput.value = url === 'about:blank' ? '' : url;
    if (url && url !== 'about:blank') {
      urlPlaceholder.setAttribute('hidden', '');
    } else {
      urlPlaceholder.removeAttribute('hidden');
    }
  });
}

// ── Button state ───────────────────────────────────────────────────────────

function updateButtons() {
  if (recording) {
    btnStart.setAttribute('hidden', '');
    recordingControls.removeAttribute('hidden');
    btnPause.innerHTML = paused
      ? '<svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:5px;margin-bottom:1px"><polygon points="0,0 11,6.5 0,13"/></svg>Resume'
      : '<svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:5px;margin-bottom:1px"><rect x="0" y="0" width="4" height="13" rx="1.5"/><rect x="7" y="0" width="4" height="13" rx="1.5"/></svg>Pause';
  } else {
    btnStart.disabled = false; // re-enable after countdown or after stopping with no steps
    btnStart.removeAttribute('hidden');
    recordingControls.setAttribute('hidden', '');
  }
  stepCountEl.textContent = steps.length > 0
    ? `${steps.length} step${steps.length === 1 ? '' : 's'}`
    : '';
}

function renderStepsList() {
  stepsList.innerHTML = window.stepsPanel.renderStepsListHtml(steps);
  stepsList.scrollTop = stepsList.scrollHeight;
  updateButtons();
}

// ── Recording lifecycle ────────────────────────────────────────────────────

// ── 3-2-1 countdown ───────────────────────────────────────────────────────────

async function startCountdown() {
  const overlay = document.getElementById('countdown-overlay');
  const numEl   = document.getElementById('countdown-number');
  overlay.removeAttribute('hidden');
  for (let n = 3; n >= 1; n--) {
    numEl.textContent = String(n);
    // Force animation to replay on each number change
    numEl.style.animation = 'none';
    void numEl.offsetWidth; // trigger reflow
    numEl.style.animation = '';
    await new Promise(r => setTimeout(r, 1000));
  }
  overlay.setAttribute('hidden', '');
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true; // block double-click during countdown
  await startCountdown();
  recording = true;
  paused    = false;
  sendToWebviewPreload('flo:start-recording');
  updateButtons();
});

btnPause.addEventListener('click', () => {
  paused = !paused;
  sendToWebviewPreload(paused ? 'flo:stop-recording' : 'flo:start-recording');
  updateButtons();
});

btnStop.addEventListener('click', async () => {
  recording = false;
  paused    = false;
  sendToWebviewPreload('flo:stop-recording');
  updateButtons();
  await openEditorWithSteps();
});

// Re-arm recording on every page navigation.
// The preload re-runs fresh on each navigation (Electron re-injects per document),
// resetting its internal `recording` flag. dom-ready fires after the fresh preload
// has registered its listeners — the ideal moment to re-send flo:start-recording.
// We also cache webviewWcId here so sendToWebviewPreload works on first click.
if (webview) {
  webview.addEventListener('dom-ready', () => {
    webviewWcId = webview.getWebContentsId();
    if (recording && !paused) {
      sendToWebviewPreload('flo:start-recording');
    }
  });
}

// ── Capture handling ───────────────────────────────────────────────────────

async function handleCapturedClick(meta) {
  // FIX: describeStep call is inside try/catch so a thrown error never silently
  // drops the step. Falls back to "Click." if anything fails.
  let text;
  try {
    text = window.flo.describeStep(meta);
  } catch {
    text = 'Click.';
  }

  // Immediate capture: grabs the current page at click time.
  // For navigation clicks this is correct (shows the page you clicked on).
  // For non-navigation clicks we follow up with a delayed re-capture below.
  let screenshotDataUrl = null;
  try {
    if (webviewWcId) {
      screenshotDataUrl = await window.flo.captureScreenshot(webviewWcId);
    }
  } catch { /* expected on navigating clicks */ }

  const subAction = { stepId: meta.stepId, text, screenshotDataUrl };
  const now = Date.now();
  const lastGroup = steps[steps.length - 1] || null;

  if (window.stepGroups.shouldMergeWithGroup(lastGroup, meta, now)) {
    lastGroup.subActions.push(subAction);
    lastGroup.lastActionAt = now;
  } else {
    steps.push({
      subActions: [subAction],
      pageUrl: meta.pageUrl,
      lastActionAt: now
    });
  }

  renderStepsList();

  // Non-navigation re-capture: if the click didn't trigger a page load,
  // wait 900ms then update the screenshot to show the interaction's result
  // (e.g. a modal that opened, a dropdown that appeared).
  // If navigation fires first (dom-ready), we cancel — the initial screenshot stays.
  if (webviewWcId) {
    let navigated = false;
    function onNav() { navigated = true; }
    webview.addEventListener('dom-ready', onNav, { once: true });
    setTimeout(async () => {
      webview.removeEventListener('dom-ready', onNav);
      if (navigated || !recording) return;
      try {
        const updated = await window.flo.captureScreenshot(webviewWcId);
        if (updated) {
          subAction.screenshotDataUrl = updated;
          renderStepsList();
        }
      } catch {}
    }, 900);
  }
}

async function handleRecapture(meta) {
  // Search from the END backward for the group containing this stepId
  for (let i = steps.length - 1; i >= 0; i--) {
    const group = steps[i];
    const actionIdx = group.subActions.findIndex(a => a.stepId === meta.stepId);
    if (actionIdx !== -1) {
      let screenshotDataUrl = null;
      try {
        if (webviewWcId) {
          screenshotDataUrl = await window.flo.captureScreenshot(webviewWcId);
        }
      } catch {}

      if (screenshotDataUrl) {
        group.subActions[actionIdx].screenshotDataUrl = screenshotDataUrl;
      }
      // FIX: update lastActionAt on recapture too (not just on new clicks), so the
      // 6-second sliding window isn't silently consumed by typing time. Without this,
      // slow typing could push what should be one continuous group past the threshold.
      group.lastActionAt = Date.now();
      renderStepsList();
      return;
    }
  }
}

if (webview) {
  webview.addEventListener('ipc-message', async (event) => {
    if (!recording || paused) return;
    if (event.channel === 'flo:click') {
      await handleCapturedClick(event.args[0]);
    } else if (event.channel === 'flo:recapture') {
      await handleRecapture(event.args[0]);
    }
  });
}

// ── End recording → Save modal ─────────────────────────────────────────────
// Nothing is saved automatically. The user must give the recording a title and
// click Save — or Discard. This keeps My Flows clean and intentional.

const saveModalOverlay  = document.getElementById('save-modal-overlay');
const saveTitleInput    = document.getElementById('save-title-input');
const saveTitleError    = document.getElementById('save-title-error');
const btnSaveConfirm    = document.getElementById('btn-save-confirm');
const btnSaveDiscard    = document.getElementById('btn-save-discard');

function showSaveModal() {
  saveTitleInput.value = '';
  saveTitleError.hidden = true;
  saveModalOverlay.removeAttribute('hidden');
  // Delay focus so the modal is visible first
  setTimeout(() => saveTitleInput.focus(), 50);
}

// Save: write to storage as v1 and open in view mode
btnSaveConfirm.addEventListener('click', async () => {
  const title = saveTitleInput.value.trim();
  if (!title) {
    saveTitleError.hidden = false;
    saveTitleInput.focus();
    return;
  }
  saveTitleError.hidden = true;
  btnSaveConfirm.disabled = true;

  try {
    const guide = {
      title,
      steps:   window.stepGroups.toSavedSteps(steps),
      version: 1   // first real save — no draft state
    };
    const saved = await window.flo.saveGuide(guide);

    // Clear captured steps before navigating so beforeunload doesn't fire
    steps = [];
    renderStepsList();
    saveModalOverlay.setAttribute('hidden', '');

    // Open in view mode — they can click Edit from there to annotate / re-order
    window.location.href = `editor.html?id=${encodeURIComponent(saved.id)}`;
  } catch (err) {
    btnSaveConfirm.disabled = false;
    alert('Save failed: ' + err.message);
  }
});

// Enter key in title field submits the form
saveTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); btnSaveConfirm.click(); }
});

// Discard: clear steps and stay on the recorder screen, webview stays at current URL.
btnSaveDiscard.addEventListener('click', () => {
  steps = [];
  renderStepsList();
  saveModalOverlay.setAttribute('hidden', '');
  recording = false;
  paused    = false;
  sendToWebviewPreload('flo:stop-recording');
  updateButtons();
});

function openEditorWithSteps() {
  if (steps.length === 0) return;
  showSaveModal();
}

// ── Unsaved-work guard ─────────────────────────────────────────────────────
// Covers any navigation away (My Guides link, URL bar, window close) not just Stop.

window.addEventListener('beforeunload', (e) => {
  if (steps.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

updateButtons();
