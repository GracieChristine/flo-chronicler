// Desktop recorder — captures system-wide mouse clicks and screenshots from a
// selected desktop window. Shares the same steps panel, grouping logic, save
// modal, and export pipeline as the web recorder.

let recording = false;
let paused = false;
let steps = [];
let selectedSource = null; // { id, name, bounds }
const pendingElements = new Map(); // UIA results keyed by "x,y", applied when step is added

// Derive recording mode from URL param (?mode=screen → monitors, default → windows)
const _modeParam = new URLSearchParams(window.location.search).get('mode');
let currentSourceType = _modeParam === 'screen' ? 'screen' : 'window';

// ── DOM refs ───────────────────────────────────────────────────────────────────
const btnStart          = document.getElementById('btn-start');
const btnPause          = document.getElementById('btn-pause');
const btnStop           = document.getElementById('btn-stop');
const recordingControls = document.getElementById('recording-controls');
const stepCountEl       = document.getElementById('step-count');
const stepsList         = document.getElementById('steps-list');
const sourceGrid          = document.getElementById('source-grid');
const sourcePicker        = document.getElementById('source-picker');
const sourcePickerHint    = document.getElementById('source-picker-hint');
const sourcePickerHeading = document.getElementById('source-picker-heading');
const recorderBody      = document.getElementById('recorder-body');
const toolbarSourceName = document.getElementById('toolbar-source-name');
const previewImg        = document.getElementById('preview-img');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewSourceName = document.getElementById('preview-source-name');

// Confirm dialog
const confirmModalOverlay = document.getElementById('confirm-modal-overlay');
const confirmModalTitle   = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const btnConfirmCancel    = document.getElementById('btn-confirm-cancel');
const btnConfirmOk        = document.getElementById('btn-confirm-ok');

// Save modal
const saveModalOverlay = document.getElementById('save-modal-overlay');
const saveTitleInput   = document.getElementById('save-title-input');
const saveTitleError   = document.getElementById('save-title-error');
const btnSaveConfirm   = document.getElementById('btn-save-confirm');
const btnSaveDiscard   = document.getElementById('btn-save-discard');

// ── Utilities ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

// ── My Flows navigation ────────────────────────────────────────────────────────

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
    window.flo.offDesktopClick();
    window.flo.offDesktopClickElement();
    await window.flo.hideDesktopOverlay();
    await window.flo.stopDesktopHook();
  }
  window.location.href = 'guides.html';
});

// ── Source picker ──────────────────────────────────────────────────────────────

async function loadSources() {
  const label = currentSourceType === 'screen' ? 'monitors' : 'windows';
  sourceGrid.innerHTML = `<p class="steps-empty">Loading ${label}…</p>`;
  let sources;
  try {
    sources = await window.flo.getDesktopSources(currentSourceType);
  } catch {
    sourceGrid.innerHTML = `<p class="steps-empty">Could not list ${label}. Try refreshing.</p>`;
    return;
  }

  if (!sources || sources.length === 0) {
    sourceGrid.innerHTML = currentSourceType === 'screen'
      ? '<p class="steps-empty">No monitors detected.</p>'
      : '<p class="steps-empty">No open windows found. Open an application and click Refresh.</p>';
    return;
  }

  sourceGrid.innerHTML = sources.map(s => `
    <div class="source-card" data-id="${escapeAttr(s.id)}" data-name="${escapeAttr(s.name)}" ${s.bounds ? `data-bounds="${escapeAttr(JSON.stringify(s.bounds))}"` : ''}>
      <img class="source-card-thumb" src="${s.thumbnailDataUrl}" alt="" />
      <span class="source-card-name" title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</span>
    </div>
  `).join('');

  // Restore selection if the window is still listed
  if (selectedSource) {
    const card = sourceGrid.querySelector(`[data-id="${CSS.escape(selectedSource.id)}"]`);
    if (card) {
      card.classList.add('selected');
    } else {
      selectedSource = null;
      btnStart.disabled = true;
      toolbarSourceName.textContent = '';
    }
  }

  sourceGrid.querySelectorAll('.source-card').forEach(card => {
    card.addEventListener('click', () => {
      sourceGrid.querySelectorAll('.source-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedSource = {
        id:     card.dataset.id,
        name:   card.dataset.name,
        bounds: card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null
      };
      btnStart.disabled = false;

      // Show border overlay immediately on selection; pre-fetch app window bounds
      const thisSource = selectedSource;
      (async () => {
        if (!thisSource.bounds && String(thisSource.id).startsWith('window:')) {
          thisSource.bounds = await window.flo.getWindowBounds(thisSource.id);
        }
        if (selectedSource !== thisSource) return; // user selected a different card
        if (thisSource.bounds) await window.flo.showDesktopOverlay(thisSource.bounds);
        else await window.flo.hideDesktopOverlay();
      })().catch(() => {});
    });
  });
}

document.getElementById('btn-refresh-sources').addEventListener('click', () => loadSources());

// Mode switcher — switch between Webpage / Desktop App / Full Monitor
document.getElementById('mode-switcher').addEventListener('click', async (e) => {
  const btn = e.target.closest('.mode-switcher-btn');
  if (!btn) return;
  const newMode = btn.dataset.mode;
  const currentMode = currentSourceType === 'screen' ? 'screen' : 'apps';
  if (newMode === currentMode) return;

  if (recording || paused || steps.length > 0) {
    const ok = await showConfirm('Switching modes will discard any captured steps. Continue?', {
      title: 'Switch mode?', okLabel: 'Switch', cancelLabel: 'Stay'
    });
    if (!ok) return;
    if (recording || paused) {
      recording = false;
      paused    = false;
      window.flo.offDesktopClick();
      window.flo.offDesktopClickElement();
      await window.flo.hideDesktopOverlay();
      await window.flo.stopDesktopHook();
    }
    steps = [];
  }

  if (newMode === 'webpage') {
    window.location.href = 'index.html?recorder=1';
  } else if (newMode === 'apps') {
    window.location.href = 'desktop.html?mode=window';
  } else {
    window.location.href = 'desktop.html?mode=screen';
  }
});

// ── Button state ───────────────────────────────────────────────────────────────

const modeSwitcher = document.getElementById('mode-switcher');

function updateButtons() {
  if (recording) {
    btnStart.setAttribute('hidden', '');
    recordingControls.removeAttribute('hidden');
    modeSwitcher.setAttribute('hidden', '');
    btnPause.innerHTML = paused
      ? '<svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:5px;margin-bottom:1px"><polygon points="0,0 11,6.5 0,13"/></svg>Resume'
      : '<svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:5px;margin-bottom:1px"><rect x="0" y="0" width="4" height="13" rx="1.5"/><rect x="7" y="0" width="4" height="13" rx="1.5"/></svg>Pause';
  } else {
    btnStart.removeAttribute('hidden');
    btnStart.disabled = !selectedSource;
    recordingControls.setAttribute('hidden', '');
    modeSwitcher.removeAttribute('hidden');
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

// ── Recording lifecycle ────────────────────────────────────────────────────────

async function startCountdown() {
  const overlay = document.getElementById('countdown-overlay');
  const numEl   = document.getElementById('countdown-number');
  overlay.removeAttribute('hidden');
  for (let n = 3; n >= 1; n--) {
    numEl.textContent = String(n);
    numEl.style.animation = 'none';
    void numEl.offsetWidth;
    numEl.style.animation = '';
    await new Promise(r => setTimeout(r, 1000));
  }
  overlay.setAttribute('hidden', '');
}

btnStart.addEventListener('click', async () => {
  if (!selectedSource) return;
  btnStart.disabled = true;

  // Hide selection overlay during countdown, re-shown after recording starts
  // Bounds pre-fetched on card selection; fall back to Flo countdown if unavailable
  const countdownBounds = selectedSource.bounds ?? null;
  await window.flo.hideDesktopOverlay();
  if (countdownBounds) {
    await window.flo.runDesktopCountdown(countdownBounds);
  } else {
    await startCountdown();
  }

  const result = await window.flo.startDesktopHook();
  if (!result || result.ok === false) {
    alert('Could not start mouse hook: ' + (result && result.reason || 'unknown error'));
    return;
  }

  // Switch to recorder view
  sourcePicker.setAttribute('hidden', '');
  recorderBody.removeAttribute('hidden');
  previewSourceName.textContent = selectedSource.name;

  recording = true;
  paused = false;

  window.flo.onDesktopClick(handleDesktopClick);
  window.flo.onDesktopClickElement(handleDesktopClickElement);
  updateButtons();

  // Show border overlay asynchronously — doesn't block recording start.
  // Screen sources have bounds immediately; App sources need a Win32 lookup.
  (async () => {
    let bounds = selectedSource.bounds ?? null;
    if (!bounds && String(selectedSource.id).startsWith('window:')) {
      bounds = await window.flo.getWindowBounds(selectedSource.id);
    }
    if (bounds) await window.flo.showDesktopOverlay(bounds);
  })().catch(() => {});
});

btnPause.addEventListener('click', () => {
  paused = !paused;
  updateButtons();
});

btnStop.addEventListener('click', async () => {
  recording = false;
  paused    = false;
  window.flo.offDesktopClick();
  window.flo.offDesktopClickElement();
  await window.flo.hideDesktopOverlay();
  await window.flo.stopDesktopHook();
  updateButtons();
  if (steps.length > 0) showSaveModal();
});

// ── Click handling + screenshot capture ───────────────────────────────────────

async function handleDesktopClick(data) {
  if (!recording || paused || !selectedSource) return;

  // For monitor sources, only register clicks within that display's screen region.
  // selectedSource.bounds is in logical (CSS) pixels; uiohook sends physical pixels.
  // Multiply by devicePixelRatio to convert logical → physical for the comparison.
  if (selectedSource.bounds) {
    const dpr = window.devicePixelRatio || 1;
    const b   = selectedSource.bounds;
    if (data.x < b.x * dpr || data.x > (b.x + b.width)  * dpr ||
        data.y < b.y * dpr || data.y > (b.y + b.height) * dpr) {
      return;
    }
  }

  const action = data.button === 2 ? 'Right-click' : 'Click';
  let clickText;
  if (currentSourceType === 'screen') {
    // Display name ("Display 2") is useless — UIA will fill in the real context
    clickText = `${action}.`;
  } else {
    const appName = selectedSource ? selectedSource.name : '';
    clickText = appName ? `${action} in ${appName}.` : `${action}.`;
  }
  const stepId    = `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Immediate screenshot
  let screenshotDataUrl = null;
  try {
    screenshotDataUrl = await window.flo.captureDesktopSource(selectedSource.id);
  } catch {}

  const subAction = { stepId, text: clickText, screenshotDataUrl, _clickX: data.x, _clickY: data.y, _button: data.button };
  const now       = Date.now();
  const lastGroup = steps[steps.length - 1] || null;
  const meta      = { pageUrl: selectedSource.id };

  if (window.stepGroups.shouldMergeWithGroup(lastGroup, meta, now)) {
    lastGroup.subActions.push(subAction);
    lastGroup.lastActionAt = now;
  } else {
    steps.push({ subActions: [subAction], pageUrl: selectedSource.id, lastActionAt: now });
  }

  // If UIA result arrived before this step was added, apply it now
  const elemKey = `${data.x},${data.y}`;
  const pendingEl = pendingElements.get(elemKey);
  if (pendingEl) {
    pendingElements.delete(elemKey);
    applyElementToStep(subAction, action, pendingEl);
  }

  if (screenshotDataUrl) {
    previewImg.src = screenshotDataUrl;
    previewImg.removeAttribute('hidden');
    previewPlaceholder.setAttribute('hidden', '');
  }

  renderStepsList();

  // Delayed re-capture — picks up any UI that changed after the click settled
  setTimeout(async () => {
    if (!recording) return;
    let delayed = null;
    try { delayed = await window.flo.captureDesktopSource(selectedSource.id); } catch {}
    if (!delayed) return;
    subAction.screenshotDataUrl = delayed;
    previewImg.src = delayed;
    previewImg.removeAttribute('hidden');
    previewPlaceholder.setAttribute('hidden', '');
    renderStepsList();
  }, 900);
}

function applyElementToStep(subAction, action, data) {
  const desc = describeElement(data.name, data.type);
  if (desc) {
    subAction.text = `${action} ${desc}.`;
    return;
  }
  if (currentSourceType === 'screen' && data.windowTitle) {
    const appName = data.windowTitle.split(' - ').pop().trim();
    if (appName) subAction.text = `${action} in ${appName}.`;
  }
}

function isInternalName(name) {
  if (!name) return false;
  if (name.startsWith('_')) return true;
  return /^[a-z][a-zA-Z]+\d+$/.test(name); // WinForms auto-names: menuStrip1, toolStrip1
}

function describeElement(name, type) {
  const typeLabels = {
    Button: 'button', CheckBox: 'checkbox', ComboBox: 'dropdown',
    Edit: 'text field', Hyperlink: 'link', ListItem: 'list item',
    MenuItem: 'menu button', RadioButton: 'radio button', Tab: 'tab',
    Text: 'text', ToolBar: 'toolbar', TreeItem: 'tree item',
    MenuBar: 'nav bar', Tree: 'project tree'
  };
  const effectiveName = isInternalName(name) ? '' : name;
  const label = typeLabels[type] || (type && type !== '' ? type.toLowerCase() : '');
  if (effectiveName && label) return `'${effectiveName}' ${label}`;
  if (effectiveName)          return `'${effectiveName}'`;
  if (label) {
    const definite = type === 'MenuBar' || type === 'Tree';
    return `${definite ? 'the' : 'a'} ${label}`;
  }
  return '';
}

function handleDesktopClickElement(data) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const group = steps[i];
    for (let j = group.subActions.length - 1; j >= 0; j--) {
      const sub = group.subActions[j];
      if (sub._clickX === data.x && sub._clickY === data.y) {
        const action  = sub._button === 2 ? 'Right-click' : 'Click';
        const before  = sub.text;
        applyElementToStep(sub, action, data);
        if (sub.text !== before) renderStepsList();
        return;
      }
    }
  }
  // Step not yet in array (screenshot capture still in flight) — stash for handleDesktopClick
  const key = `${data.x},${data.y}`;
  pendingElements.set(key, data);
  setTimeout(() => pendingElements.delete(key), 5000);
}

// ── Save modal ─────────────────────────────────────────────────────────────────

function showSaveModal() {
  saveTitleInput.value = '';
  saveTitleError.hidden = true;
  saveModalOverlay.removeAttribute('hidden');
  setTimeout(() => saveTitleInput.focus(), 50);
}

btnSaveConfirm.addEventListener('click', async () => {
  const title = saveTitleInput.value.trim();
  if (!title) {
    saveTitleError.hidden = false;
    saveTitleInput.focus();
    return;
  }
  saveTitleError.hidden    = true;
  btnSaveConfirm.disabled  = true;

  try {
    const guide = {
      title,
      steps:   window.stepGroups.toSavedSteps(steps),
      version: 1
    };
    const saved = await window.flo.saveGuide(guide);
    steps = [];
    renderStepsList();
    saveModalOverlay.setAttribute('hidden', '');
    window.location.href = `editor.html?id=${encodeURIComponent(saved.id)}`;
  } catch (err) {
    btnSaveConfirm.disabled = false;
    alert('Save failed: ' + err.message);
  }
});

saveTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); btnSaveConfirm.click(); }
});

// Discard: clear steps and go back to source picker
btnSaveDiscard.addEventListener('click', async () => {
  steps = [];
  renderStepsList();
  saveModalOverlay.setAttribute('hidden', '');
  recording = false;
  paused    = false;
  window.flo.offDesktopClick();
  window.flo.offDesktopClickElement();
  await window.flo.hideDesktopOverlay();
  await window.flo.stopDesktopHook();

  // Reset preview and return to source picker
  previewImg.setAttribute('hidden', '');
  previewPlaceholder.removeAttribute('hidden');
  recorderBody.setAttribute('hidden', '');
  sourcePicker.removeAttribute('hidden');

  updateButtons();
});

// ── Unsaved-work guard ─────────────────────────────────────────────────────────

window.addEventListener('beforeunload', (e) => {
  if (steps.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────

// Set correct active pill and heading text based on the mode param
(function initMode() {
  const activeMode = currentSourceType === 'screen' ? 'screen' : 'apps';
  modeSwitcher.querySelectorAll('.mode-switcher-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === activeMode);
  });

  toolbarSourceName.textContent   = '';
  sourcePickerHeading.textContent = currentSourceType === 'screen'
    ? 'Available Screens'
    : 'Available Apps';
})();

loadSources();
updateButtons();
