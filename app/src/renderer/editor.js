// Editor screen: view mode (read-only, export) and edit mode (full editing).
//
// URL scheme:
//   editor.html?id=xxx           → view / read-only mode
//   editor.html?id=xxx&edit=1    → edit mode
//
// Workflow:
//   Recording done   → opens in edit mode  (app.js appends &edit=1)
//   My Guides → Open → opens in view mode
//   View mode "Edit" button → reloads with &edit=1
//   Edit mode "Save"        → saves and reloads WITHOUT &edit=1 (returns to view mode)

// ── Mode detection ─────────────────────────────────────────────────────────

const params     = new URLSearchParams(window.location.search);
const guideId    = params.get('id');
const isEditMode = params.has('edit');

// Stamp body so CSS can toggle elements via .view-only / .edit-only classes
document.body.classList.add(isEditMode ? 'edit-mode' : 'view-mode');

// ── Module-level state ─────────────────────────────────────────────────────

let guide = null;

// Dirty / draft tracking (edit mode only)
let isDraft          = false;  // true when guide.version === 0 (recorder draft, never saved by user)
let isDirty          = false;  // true when content has changed since entering edit mode
let savedFingerprint = null;   // baseline fingerprint taken on entering edit mode

// Edit-mode: split modal
let splitIndex = -1;

// Edit-mode: upload / replace screenshot
let uploadTargetIndex = -1;

// Edit-mode: annotation (redact) modal
let redactIndex     = -1;
let redactBaseImage = null;
let redactHistory   = [];
let currentTool     = 'rect';
let annotationColor = '#d6455a';
let isDrawing       = false;
let drawStart       = null;

// ── Element references ─────────────────────────────────────────────────────

const titleInput          = document.getElementById('guide-title');
const titleView           = document.getElementById('guide-title-view');
const versionBadge        = document.getElementById('guide-version-badge');
const editorSteps         = document.getElementById('editor-steps');
const btnBack             = document.getElementById('btn-back');
const btnEdit             = document.getElementById('btn-edit');
const btnSave             = document.getElementById('btn-save');
const btnCancel           = document.getElementById('btn-cancel');
const btnExportPdf        = document.getElementById('btn-export-pdf');
const btnExportWord       = document.getElementById('btn-export-word');
const btnExportConfluence = document.getElementById('btn-export-confluence');
const btnAddStep          = document.getElementById('btn-add-step');
const fileInput           = document.getElementById('screenshot-file-input');

// Split modal
const splitModalOverlay = document.getElementById('split-modal-overlay');
const splitRows         = document.getElementById('split-rows');
const btnSplitCancel    = document.getElementById('btn-split-cancel');
const btnSplitApply     = document.getElementById('btn-split-apply');

// Version history modal
const versionModalOverlay = document.getElementById('version-modal-overlay');
const versionRows         = document.getElementById('version-rows');
const btnVersionClose     = document.getElementById('btn-version-close');

// Annotation modal
const redactModalOverlay  = document.getElementById('redact-modal-overlay');
const redactCanvasWrap    = document.getElementById('redact-canvas-wrap');
const redactCanvas        = document.getElementById('redact-canvas');
const redactCtx           = redactCanvas.getContext('2d');
const btnUndoAnnotation   = document.getElementById('btn-undo-annotation');
const btnCancelAnnotation = document.getElementById('btn-cancel-annotation');
const btnDoneAnnotation   = document.getElementById('btn-done-annotation');

// Confirm dialog (styled replacement for native confirm())
const confirmModalOverlay  = document.getElementById('confirm-modal-overlay');
const confirmModalTitle    = document.getElementById('confirm-modal-title');
const confirmModalMessage  = document.getElementById('confirm-modal-message');
const btnConfirmCancel     = document.getElementById('btn-confirm-cancel');
const btnConfirmOk         = document.getElementById('btn-confirm-ok');

// Confluence modal
const confluenceModalOverlay = document.getElementById('confluence-modal-overlay');
const cfBaseUrl              = document.getElementById('cf-base-url');
const cfSpaceKey             = document.getElementById('cf-space-key');
const cfEmail                = document.getElementById('cf-email');
const cfToken                = document.getElementById('cf-token');
const cfPageTitle            = document.getElementById('cf-page-title');
const cfResult               = document.getElementById('cf-result');
const btnCfCancel            = document.getElementById('btn-cf-cancel');
const btnCfSubmit            = document.getElementById('btn-cf-submit');

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Markdown rendering ─────────────────────────────────────────────────────
// Storage format: **bold**, *italic*, `code`, - bullet, 1. ordered, 2-space indent for sub-lists

function renderInlineFormatting(escaped) {
  // Input is already HTML-escaped; apply inline markers only
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  const parts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Unordered list block ─────────────────────────────────────────────
    if (/^\s*- /.test(line)) {
      let html = '<ul>';
      while (i < lines.length && /^\s*- /.test(lines[i])) {
        const m = lines[i].match(/^(\s*)- (.*)/);
        const depth = Math.floor(m[1].length / 2);
        const styles = ['disc', 'circle', 'square'];
        const type = styles[Math.min(depth, styles.length - 1)];
        html += `<li style="margin-left:${depth * 1.2}em;list-style-type:${type}">`
              + renderInlineFormatting(escapeHtml(m[2])) + '</li>';
        i++;
      }
      parts.push(html + '</ul>');
      continue;
    }

    // ── Ordered list block (numeric top-level, alpha/roman sub-levels) ───
    if (/^\s*\d+\. /.test(line) || /^\s+[a-z]\. /.test(line)) {
      let html = '<ol>';
      while (i < lines.length && (/^\s*\d+\. /.test(lines[i]) || /^\s+[a-z]\. /.test(lines[i]))) {
        const numM   = lines[i].match(/^(\s*)(\d+)\. (.*)/);
        const alphaM = lines[i].match(/^(\s*)([a-z])\. (.*)/);
        const m      = numM || alphaM;
        const depth  = Math.floor(m[1].length / 2);
        const types  = ['decimal', 'lower-alpha', 'lower-roman'];
        const type   = types[Math.min(depth, types.length - 1)];
        html += `<li style="margin-left:${depth * 1.2}em;list-style-type:${type}">`
              + renderInlineFormatting(escapeHtml(m[3])) + '</li>';
        i++;
      }
      parts.push(html + '</ol>');
      continue;
    }

    // ── Regular line ─────────────────────────────────────────────────────
    parts.push(renderInlineFormatting(escapeHtml(line)));
    i++;
  }

  // Join: no <br> adjacent to list blocks; <br> between text lines
  return parts.reduce((acc, part, j) => {
    if (j === 0) return part;
    const prev = parts[j - 1];
    const isBlock = (s) => s.startsWith('<ul') || s.startsWith('<ol');
    return acc + (isBlock(prev) || isBlock(part) ? '' : '<br>') + part;
  }, '');
}

// ── Inline formatting toolbar helpers ──────────────────────────────────────

// Wrap selected text (or insert markers at cursor) in a textarea.
// Uses execCommand so the action lands in the browser's undo stack (Ctrl+Z works).
function applyFormat(textarea, marker) {
  textarea.focus();
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const sel   = textarea.value.slice(start, end);
  // Replace the selection with marker+content+marker; execCommand preserves undo history
  document.execCommand('insertText', false, marker + sel + marker);
  // Re-select just the wrapped content (between the two markers)
  textarea.setSelectionRange(start + marker.length, start + marker.length + sel.length);
}

// ── List toolbar helpers ────────────────────────────────────────────────────

function getLineAt(textarea) {
  const pos  = textarea.selectionStart;
  const text = textarea.value;
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineEndRaw = text.indexOf('\n', pos);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  return { pos, text, lineStart, lineEnd, line: text.slice(lineStart, lineEnd) };
}

function setLine(textarea, lineStart, lineEnd, newLine) {
  textarea.focus();
  // Select exactly the current line text (without trailing newline), replace via execCommand
  // so the edit lands on the undo stack and Ctrl+Z works.
  textarea.setSelectionRange(lineStart, lineEnd);
  document.execCommand('insertText', false, newLine);
  // After execCommand the cursor sits at lineStart + newLine.length; make it explicit.
  textarea.setSelectionRange(lineStart + newLine.length, lineStart + newLine.length);
  // execCommand fires 'input' automatically, no manual dispatch needed.
}

function applyListToggle(textarea, type) {
  const { text, lineStart, lineEnd, line } = getLineAt(textarea);
  const hasUl  = /^\s*- /.test(line);
  const hasOl  = /^\s*\d+\. /.test(line);

  let newLine;
  if (type === 'ul') {
    if (hasUl) {
      newLine = line.replace(/^(\s*)- /, '$1');           // remove
    } else if (hasOl) {
      newLine = line.replace(/^(\s*)\d+\. /, '$1- ');     // switch
    } else {
      newLine = '- ' + line;                               // add
    }
  } else {
    if (hasOl) {
      newLine = line.replace(/^(\s*)\d+\. /, '$1');        // remove
    } else if (hasUl) {
      newLine = line.replace(/^(\s*)- /, '$11. ');          // switch
    } else {
      // Auto-number: peek at previous line
      const prev = text.slice(0, lineStart).split('\n').pop() || '';
      const prevNum = prev.match(/^\s*(\d+)\. /);
      const n = prevNum ? parseInt(prevNum[1], 10) + 1 : 1;
      newLine = n + '. ' + line;
    }
  }
  setLine(textarea, lineStart, lineEnd, newLine);
}

function handleListEnter(e, textarea) {
  const { text, lineStart, lineEnd, line } = getLineAt(textarea);
  const curPos = textarea.selectionStart;

  // Unordered: "  - content"
  const ulM = line.match(/^(\s*)- (.*)/);
  if (ulM) {
    e.preventDefault();
    const [, indent, content] = ulM;
    if (!content.trim()) {
      // Empty bullet → break out (delete the bullet prefix)
      textarea.value = text.slice(0, lineStart) + text.slice(lineEnd);
      textarea.selectionStart = textarea.selectionEnd = lineStart;
    } else {
      const ins = '\n' + indent + '- ';
      textarea.value = text.slice(0, curPos) + ins + text.slice(curPos);
      textarea.selectionStart = textarea.selectionEnd = curPos + ins.length;
    }
    textarea.dispatchEvent(new Event('input'));
    return true;
  }

  // Ordered numeric: "  1. content"
  const olNumM = line.match(/^(\s*)(\d+)\. (.*)/);
  if (olNumM) {
    e.preventDefault();
    const [, indent, num, content] = olNumM;
    if (!content.trim()) {
      textarea.value = text.slice(0, lineStart) + text.slice(lineEnd);
      textarea.selectionStart = textarea.selectionEnd = lineStart;
    } else {
      const ins = '\n' + indent + (parseInt(num, 10) + 1) + '. ';
      textarea.value = text.slice(0, curPos) + ins + text.slice(curPos);
      textarea.selectionStart = textarea.selectionEnd = curPos + ins.length;
    }
    textarea.dispatchEvent(new Event('input'));
    return true;
  }

  // Ordered alpha: "  a. content"
  const olAlphaM = line.match(/^(\s*)([a-z])\. (.*)/);
  if (olAlphaM) {
    e.preventDefault();
    const [, indent, letter, content] = olAlphaM;
    if (!content.trim()) {
      textarea.value = text.slice(0, lineStart) + text.slice(lineEnd);
      textarea.selectionStart = textarea.selectionEnd = lineStart;
    } else {
      const next = letter === 'z' ? 'a' : String.fromCharCode(letter.charCodeAt(0) + 1);
      const ins  = '\n' + indent + next + '. ';
      textarea.value = text.slice(0, curPos) + ins + text.slice(curPos);
      textarea.selectionStart = textarea.selectionEnd = curPos + ins.length;
    }
    textarea.dispatchEvent(new Event('input'));
    return true;
  }

  return false;
}

function handleListTab(e, textarea) {
  const { text, lineStart, lineEnd, line } = getLineAt(textarea);

  const ulM      = line.match(/^(\s*)- (.*)/);
  const olNumM   = line.match(/^(\s*)(\d+)\. (.*)/);
  const olAlphaM = !olNumM && line.match(/^(\s*)([a-z])\. (.*)/);

  if (!ulM && !olNumM && !olAlphaM) return false; // not in a list

  e.preventDefault();

  let newLine;
  if (e.shiftKey) {
    // Dedent: remove 2 leading spaces
    newLine = line.startsWith('  ') ? line.slice(2) : line;
  } else {
    if (ulM) {
      // Indent unordered: just add 2 spaces (stays as `- ` but deeper)
      newLine = '  ' + line;
    } else if (olNumM) {
      // Indent ordered: switch to alpha sub-list
      newLine = olNumM[1] + '  a. ' + olNumM[3];
    } else {
      // Indent alpha: add 2 spaces (goes deeper)
      newLine = '  ' + line;
    }
  }
  setLine(textarea, lineStart, lineEnd, newLine);
  return true;
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

// Styled replacement for the native confirm() dialog.
// Returns a Promise that resolves to true (OK) or false (Cancel).
// options.title      — heading text (default "Confirm")
// options.okLabel    — OK button label (default "Confirm")
// options.cancelLabel — Cancel button label (default "Cancel")
// options.dangerous  — when true the OK button uses btn-danger (red); otherwise btn-primary
function showConfirm(message, { title = 'Confirm', okLabel = 'Confirm', cancelLabel = 'Cancel', dangerous = true } = {}) {
  return new Promise((resolve) => {
    confirmModalTitle.textContent   = title;
    confirmModalMessage.textContent = message;
    btnConfirmOk.textContent        = okLabel;
    btnConfirmOk.className          = 'btn ' + (dangerous ? 'btn-danger' : 'btn-primary');
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

// Fingerprint of user-editable content — mirrors the logic in storage.js so that
// "isDirty" exactly predicts whether saving would bump the version number.
function guideFingerprint(g) {
  return JSON.stringify({
    title: g.title || '',
    steps: (g.steps || []).map(s => ({
      text:              s.text || '',
      screenshotDataUrl: s.screenshotDataUrl || '',
      subSteps:          (s.subSteps || []).map(ss => ss.text || '')
    }))
  });
}

// Re-evaluate whether the current guide content differs from the saved baseline
// and enable/disable the Save button accordingly. No-op for drafts (always enabled).
function checkDirty() {
  if (!isEditMode || isDraft || !savedFingerprint) return;
  isDirty = guideFingerprint(guide) !== savedFingerprint;
  btnSave.disabled = !isDirty;
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  if (!guideId) { alert('No guide ID in URL.'); return; }

  guide = await window.flo.loadGuide(guideId);
  if (!guide) { alert('Guide not found.'); return; }

  // ── Version badge ──────────────────────────────────────────────────────────
  isDraft = guide.version === 0;

  if (isDraft) {
    versionBadge.textContent = 'Draft';
    versionBadge.title       = 'Not yet saved — click Save to publish as v1.0';
    versionBadge.classList.add('is-draft');
  } else {
    const ver = guide.version || 1;
    versionBadge.textContent = `v${ver}.0`;
    versionBadge.style.cursor = 'pointer';
    versionBadge.title = `Version ${ver}.0 — click to view history`;
    versionBadge.addEventListener('click', openVersionModal);
  }

  // ── Mode setup ─────────────────────────────────────────────────────────────
  if (isEditMode) {
    titleInput.value = guide.title || '';
    // Disable Save until something actually changes
    savedFingerprint = guideFingerprint(guide);
    btnSave.disabled = true;
    isDirty = false;
  } else {
    titleView.textContent = guide.title || 'Untitled';
  }

  renderSteps();
}

// ── Render steps ───────────────────────────────────────────────────────────

function renderSteps() {
  editorSteps.innerHTML = '';
  (guide.steps || []).forEach((step, i) => {
    const card = isEditMode ? buildEditCard(step, i) : buildViewCard(step, i);
    editorSteps.appendChild(card);
  });
  // Re-evaluate dirty state after any step-level mutation (add / delete / reorder)
  checkDirty();
}

// ── View mode step card ────────────────────────────────────────────────────

function buildViewCard(step, i) {
  // Outer wrapper: "Step X" label sits above the card, identical pattern to edit mode.
  const wrap = document.createElement('div');
  wrap.className = 'step-wrap';

  const label = document.createElement('div');
  label.className = 'step-label';
  label.textContent = `Step ${i + 1}`;
  wrap.appendChild(label);

  // The card itself: 50/50 image | text
  const card = document.createElement('div');
  card.className = 'view-card';

  // ── Left: screenshot ───────────────────────────────────────────────────
  const imageCol = document.createElement('div');
  imageCol.className = 'view-card-image';

  const canvas = document.createElement('canvas');
  canvas.className = 'view-shot';
  canvas.width  = 640;
  canvas.height = 400;
  setupCanvas(canvas, step);
  imageCol.appendChild(canvas);
  card.appendChild(imageCol);

  // ── Right: step text ───────────────────────────────────────────────────
  const content = document.createElement('div');
  content.className = 'view-card-content';

  const text = document.createElement('p');
  text.className = 'view-card-text';
  text.innerHTML = renderMarkdown(step.text || '');
  content.appendChild(text);

  card.appendChild(content);
  wrap.appendChild(card);
  return wrap;
}

// ── Edit mode step card ────────────────────────────────────────────────────

function buildEditCard(step, i) {
  // Outer wrapper: "Step X" label sits above the card, same as view mode.
  const wrap = document.createElement('div');
  wrap.className = 'step-wrap';

  const label = document.createElement('div');
  label.className = 'step-label';
  label.textContent = `Step ${i + 1}`;
  wrap.appendChild(label);

  const card = document.createElement('div');
  card.className = 'edit-card';
  card.dataset.index = i;

  // Drag handle — draggable is on the handle only so that
  // selecting text inside the card doesn't accidentally start a drag.
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  handle.draggable = true;
  card.appendChild(handle);

  // Thumbnail canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'step-shot';
  canvas.width  = 220;
  canvas.height = 140;
  setupCanvas(canvas, step);
  card.appendChild(canvas);

  // Main content area (no step number header — it lives above the card now)
  const main = document.createElement('div');
  main.className = 'edit-card-main';

  // Formatting toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'format-toolbar';

  // List buttons first
  [
    { label: '•',  title: 'Bullet list',   type: 'ul' },
    { label: '1.', title: 'Numbered list', type: 'ol' },
  ].forEach(({ label, title, type }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'format-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); applyListToggle(textarea, type); });
    toolbar.appendChild(btn);
  });

  // Separator
  const sep = document.createElement('span');
  sep.className = 'format-sep';
  toolbar.appendChild(sep);

  // Inline formatting buttons
  [
    { label: 'B',    cls: 'format-btn-bold',   action: () => applyFormat(textarea, '**'), title: 'Bold (Ctrl+B)'   },
    { label: 'I',    cls: 'format-btn-italic',  action: () => applyFormat(textarea, '*'),  title: 'Italic (Ctrl+I)' },
    { label: 'Code', cls: 'format-btn-code',    action: () => applyFormat(textarea, '`'),  title: 'Code (Ctrl+E)'   },
  ].forEach(({ label, cls, action, title }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `format-btn ${cls}`;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); action(); });
    toolbar.appendChild(btn);
  });
  main.appendChild(toolbar);

  // Auto-expanding textarea
  const textarea = document.createElement('textarea');
  textarea.className = 'edit-card-textarea';
  textarea.value = step.text || '';
  textarea.rows = 2;
  textarea.addEventListener('input', () => {
    guide.steps[i].text = textarea.value;
    autoResize(textarea);
    checkDirty();
  });
  textarea.addEventListener('keydown', (e) => {
    // List-aware Enter and Tab
    if (e.key === 'Enter' && !e.shiftKey) { if (handleListEnter(e, textarea)) return; }
    if (e.key === 'Tab')                  { if (handleListTab(e, textarea))   return; }
    // Ctrl/Cmd shortcuts for inline formatting
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === 'b') { e.preventDefault(); applyFormat(textarea, '**'); }
    if (e.key === 'i') { e.preventDefault(); applyFormat(textarea, '*');  }
    if (e.key === 'e') { e.preventDefault(); applyFormat(textarea, '`');  }
  });
  main.appendChild(textarea);
  // Resize after render (needs to be in the DOM first; we use setTimeout 0)
  setTimeout(() => autoResize(textarea), 0);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // Annotate
  const btnAnnotate = document.createElement('button');
  btnAnnotate.className = 'btn btn-secondary';
  btnAnnotate.textContent = 'Annotate Screenshot';
  btnAnnotate.disabled = !step.screenshotDataUrl;
  btnAnnotate.addEventListener('click', () => openRedactModal(i));
  actions.appendChild(btnAnnotate);

  // Upload / Replace screenshot
  const btnUpload = document.createElement('button');
  btnUpload.className = 'btn btn-secondary';
  btnUpload.textContent = step.screenshotDataUrl ? 'Replace Screenshot' : 'Upload Screenshot';
  btnUpload.addEventListener('click', () => {
    uploadTargetIndex = i;
    fileInput.value = '';
    fileInput.click();
  });
  actions.appendChild(btnUpload);

  // Split up steps (only for grouped steps with sub-actions)
  if (step.subSteps && step.subSteps.length > 1) {
    const btnSplit = document.createElement('button');
    btnSplit.className = 'btn btn-secondary';
    btnSplit.textContent = 'Split up steps';
    btnSplit.addEventListener('click', () => openSplitModal(i));
    actions.appendChild(btnSplit);
  }

  // Delete
  const btnDel = document.createElement('button');
  btnDel.className = 'btn btn-secondary';
  btnDel.style.color = 'var(--color-danger)';
  btnDel.textContent = 'Delete step';
  btnDel.addEventListener('click', () => {
    guide.steps.splice(i, 1);
    renderSteps();
  });
  actions.appendChild(btnDel);

  main.appendChild(actions);
  card.appendChild(main);

  // Drag-and-drop reorder: dragstart/dragend live on the HANDLE so that clicking
  // inside the textarea or selecting text in the card body doesn't trigger a drag.
  handle.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
    // Dim the whole wrap (label + card) so the drag ghost looks right
    setTimeout(() => wrap.style.opacity = '0.4', 0);
  });
  handle.addEventListener('dragend', () => {
    wrap.style.opacity = '';
    document.querySelectorAll('.edit-card').forEach(c => c.classList.remove('drag-over'));
  });
  // dragover/drop stay on the card so the whole card is a valid drop target.
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.edit-card').forEach(c => c.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const srcIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const destIndex = i;
    if (srcIndex === destIndex) return;
    const [moved] = guide.steps.splice(srcIndex, 1);
    guide.steps.splice(destIndex, 0, moved);
    renderSteps();
  });

  wrap.appendChild(card);
  return wrap;
}

function setupCanvas(canvas, step) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!step.screenshotDataUrl) {
    ctx.fillStyle = '#fbecee';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c87a85';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No screenshot', canvas.width / 2, canvas.height / 2);
    return;
  }

  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };
  img.src = step.screenshotDataUrl;
}

// ── Toolbar actions ────────────────────────────────────────────────────────

// "My Flows" back link — always goes to the list.
// Warns if there are unsaved edits.
btnBack.addEventListener('click', async (e) => {
  e.preventDefault();
  if (isDirty) {
    const ok = await showConfirm(
      'You have unsaved changes. If you leave now they will be lost.',
      { title: 'Leave without saving?', okLabel: 'Leave', cancelLabel: 'Keep editing' }
    );
    if (!ok) return;
  }
  isDirty = false;
  window.location.href = 'guides.html';
});

// Cancel — exits edit mode back to the read-only view of the same doc.
// Warns if there are unsaved edits.
btnCancel.addEventListener('click', async () => {
  if (isDirty) {
    const ok = await showConfirm(
      'Discard your changes and return to the read-only view?',
      { title: 'Discard changes?', okLabel: 'Discard', cancelLabel: 'Keep editing' }
    );
    if (!ok) return;
  }
  isDirty = false;
  window.location.href = `editor.html?id=${encodeURIComponent(guideId)}`;
});

// Catch window close or URL-bar navigation that bypasses our Back button
window.addEventListener('beforeunload', (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Switch to edit mode
btnEdit.addEventListener('click', () => {
  window.location.href = `editor.html?id=${encodeURIComponent(guideId)}&edit=1`;
});

// Save: write changes and return to view mode
btnSave.addEventListener('click', async () => {
  if (!guide) return;
  if (titleInput) guide.title = titleInput.value;
  btnSave.disabled = true;
  btnSave.textContent = 'Saving…';
  try {
    guide = await window.flo.saveGuide(guide);
    // Clear flag so beforeunload doesn't prompt during the page reload
    isDirty = false;
    // Return to view mode — guide is now published with its assigned version
    window.location.href = `editor.html?id=${encodeURIComponent(guide.id)}`;
  } catch (err) {
    alert('Save failed: ' + err.message);
    btnSave.disabled = false;
    btnSave.textContent = 'Save';
  }
});

if (titleInput) {
  titleInput.addEventListener('input', () => {
    if (guide) guide.title = titleInput.value;
    checkDirty();
  });
}

// Export PDF (view mode only)
if (btnExportPdf) {
  btnExportPdf.addEventListener('click', async () => {
    if (!guide) return;
    const result = await window.flo.exportPdf(guide.id);
    if (!result.ok && result.reason !== 'cancelled') {
      alert(`PDF export failed: ${result.reason}`);
    }
  });
}

// Export Word (view mode only)
if (btnExportWord) {
  btnExportWord.addEventListener('click', async () => {
    if (!guide) return;
    const result = await window.flo.exportWord(guide.id);
    if (!result.ok && result.reason !== 'cancelled') {
      alert(`Word export failed: ${result.reason}`);
    }
  });
}

// Export Confluence (view mode only)
if (btnExportConfluence) {
  btnExportConfluence.addEventListener('click', () => {
    if (!guide) return;
    cfPageTitle.value = guide.title || '';
    const prefs = loadConfluencePrefs();
    if (prefs) {
      cfBaseUrl.value  = prefs.baseUrl  || '';
      cfSpaceKey.value = prefs.spaceKey || '';
      cfEmail.value    = prefs.email    || '';
    }
    cfToken.value = '';
    cfResult.innerHTML = '';
    confluenceModalOverlay.removeAttribute('hidden');
    // Close the dropdown after launching the modal
    exportDropdownMenu.setAttribute('hidden', '');
  });
}

// Export dropdown toggle
const btnExportToggle    = document.getElementById('btn-export-toggle');
const exportDropdownMenu = document.getElementById('export-dropdown-menu');

if (btnExportToggle && exportDropdownMenu) {
  // Toggle open/close when the button is clicked
  btnExportToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !exportDropdownMenu.hasAttribute('hidden');
    if (isOpen) {
      exportDropdownMenu.setAttribute('hidden', '');
    } else {
      exportDropdownMenu.removeAttribute('hidden');
    }
  });

  // Close the dropdown when clicking anywhere outside it
  document.addEventListener('click', (e) => {
    if (!btnExportToggle.contains(e.target) && !exportDropdownMenu.contains(e.target)) {
      exportDropdownMenu.setAttribute('hidden', '');
    }
  });

  // Close the dropdown after any export item is clicked
  [btnExportPdf, btnExportWord].forEach(btn => {
    if (btn) btn.addEventListener('click', () => {
      exportDropdownMenu.setAttribute('hidden', '');
    }, { capture: true });
  });
}

// Add step (edit mode only)
btnAddStep.addEventListener('click', () => {
  if (!guide) return;
  guide.steps.push({ text: 'New step — describe what happens here.', screenshotDataUrl: null });
  renderSteps();
  editorSteps.lastElementChild && editorSteps.lastElementChild.scrollIntoView({ behavior: 'smooth' });
});

// ── Upload / Replace screenshot ────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file || uploadTargetIndex < 0) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    guide.steps[uploadTargetIndex].screenshotDataUrl = e.target.result;
    uploadTargetIndex = -1;
    renderSteps();
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

// ── Split modal ────────────────────────────────────────────────────────────

function openSplitModal(index) {
  splitIndex = index;
  const step = guide.steps[index];

  splitRows.innerHTML = step.subSteps.map((sub, i) => `
    <div class="split-row">
      <input type="checkbox" id="split-cb-${i}" data-sub-index="${i}" />
      <label for="split-cb-${i}">${escapeHtml(sub.text)}</label>
    </div>`).join('');

  splitModalOverlay.removeAttribute('hidden');
}

btnSplitCancel.addEventListener('click', () => {
  splitModalOverlay.setAttribute('hidden', '');
  splitIndex = -1;
});

btnSplitApply.addEventListener('click', () => {
  if (splitIndex < 0) return;

  const step      = guide.steps[splitIndex];
  const checkboxes = splitRows.querySelectorAll('input[type="checkbox"]');
  const pullOut   = Array.from(checkboxes).map(cb => cb.checked);

  if (!pullOut.some(Boolean)) {
    splitModalOverlay.setAttribute('hidden', '');
    splitIndex = -1;
    return;
  }

  const resultSteps = [];
  let run = [];

  step.subSteps.forEach((sub, i) => {
    if (pullOut[i]) {
      if (run.length > 0) {
        resultSteps.push(window.stepGroups.toSavedStep(run));
        run = [];
      }
      resultSteps.push(window.stepGroups.toSavedStep([sub]));
    } else {
      run.push(sub);
    }
  });
  if (run.length > 0) resultSteps.push(window.stepGroups.toSavedStep(run));

  guide.steps.splice(splitIndex, 1, ...resultSteps);
  splitModalOverlay.setAttribute('hidden', '');
  splitIndex = -1;
  renderSteps();
});

// ── Version history modal ──────────────────────────────────────────────────

async function openVersionModal() {
  versionRows.innerHTML = '<p style="color:var(--color-text-muted)">Loading…</p>';
  versionModalOverlay.removeAttribute('hidden');

  const versions = await window.flo.listGuideVersions(guideId);

  if (!versions || versions.length === 0) {
    versionRows.innerHTML = '<p style="color:var(--color-text-muted)">No previous versions saved yet. Versions are created each time you save.</p>';
    return;
  }

  versionRows.innerHTML = versions.map(v => {
    const date = v.updatedAt ? new Date(v.updatedAt).toLocaleString(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) : '—';
    const steps = v.stepCount === 1 ? '1 step' : `${v.stepCount} steps`;
    return `<div class="version-row">
      <div class="version-row-info">
        <span class="version-row-num">v${v.version}.0</span>
        <span class="version-row-meta">${escapeHtml(date)} &mdash; ${steps}</span>
      </div>
      <button class="btn btn-secondary btn-restore-version" data-version="${v.version}">Restore</button>
    </div>`;
  }).join('');

  versionRows.querySelectorAll('.btn-restore-version').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ver = parseInt(btn.dataset.version, 10);
      const old = await window.flo.loadGuideVersion(guideId, ver);
      if (!old) { alert('Could not load that version.'); return; }

      // Save current guide as a new version first, then overwrite with the old one
      // (so nothing is lost — current state becomes the next archived version)
      const restored = await window.flo.saveGuide({ ...old, id: guideId });
      versionModalOverlay.setAttribute('hidden', '');
      window.location.href = `editor.html?id=${encodeURIComponent(guideId)}&edit=1`;
    });
  });
}

btnVersionClose.addEventListener('click', () => {
  versionModalOverlay.setAttribute('hidden', '');
});

// ── Annotation modal ───────────────────────────────────────────────────────

function openRedactModal(index) {
  redactIndex   = index;
  redactHistory = [];
  currentTool   = 'rect';

  redactModalOverlay.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === 'rect'));

  const step = guide.steps[index];
  const img  = new Image();

  img.onload = () => {
    redactCanvas.width  = img.naturalWidth;
    redactCanvas.height = img.naturalHeight;
    redactCtx.drawImage(img, 0, 0);
    redactBaseImage = redactCtx.getImageData(0, 0, redactCanvas.width, redactCanvas.height);
    btnUndoAnnotation.disabled = true;
    redactModalOverlay.removeAttribute('hidden');
  };
  img.src = step.screenshotDataUrl;
}

function redactCanvasPoint(e) {
  const rect   = redactCanvas.getBoundingClientRect();
  const scaleX = redactCanvas.width  / rect.width;
  const scaleY = redactCanvas.height / rect.height;
  return {
    x: (e.clientX - rect.left)  * scaleX,
    y: (e.clientY - rect.top)   * scaleY
  };
}

function commitAnnotation() {
  redactHistory.push(redactBaseImage);
  redactBaseImage = redactCtx.getImageData(0, 0, redactCanvas.width, redactCanvas.height);
  btnUndoAnnotation.disabled = false;
}

function redrawBase() {
  redactCtx.putImageData(redactBaseImage, 0, 0);
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const len     = Math.hypot(x2 - x1, y2 - y1);
  const headLen = Math.max(14, Math.min(28, len * 0.25));
  const angle   = Math.atan2(y2 - y1, x2 - x1);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function applyBlur(ctx, x, y, w, h) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  if (w < 2 || h < 2) return;
  const blurAmount = Math.max(6, Math.min(w, h) * 0.1);
  ctx.save();
  ctx.filter = `blur(${blurAmount}px)`;
  ctx.drawImage(redactCanvas, x, y, w, h, x, y, w, h);
  ctx.restore();
}

function outlineColorFor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

redactCanvas.addEventListener('mousedown', (e) => {
  if (currentTool === 'text') {
    e.preventDefault();
    const pt    = redactCanvasPoint(e);
    const rect  = redactCanvas.getBoundingClientRect();
    const wrap  = redactCanvasWrap;
    const inputLeft = (e.clientX - rect.left)  + wrap.scrollLeft;
    const inputTop  = (e.clientY - rect.top)   + wrap.scrollTop;

    const textInput = document.createElement('input');
    textInput.type      = 'text';
    textInput.className = 'annotate-text-input';
    textInput.style.left = inputLeft + 'px';
    textInput.style.top  = inputTop  + 'px';
    wrap.appendChild(textInput);
    textInput.focus();

    let committed = false;
    function commitText() {
      if (committed) return;
      committed = true;
      const value = textInput.value;
      if (textInput.parentNode) textInput.parentNode.removeChild(textInput);
      if (!value.trim()) return;

      // Draw text in the selected colour only — no contrast outline/stroke.
      // The outline (strokeText) added an unwanted white or dark ring around
      // the text that clashed with the user's chosen colour.
      redactCtx.font         = 'bold 26px sans-serif';
      redactCtx.textBaseline = 'top';
      redactCtx.fillStyle    = annotationColor;
      redactCtx.fillText(value, pt.x, pt.y);
      commitAnnotation();
    }

    textInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { commitText(); }
      if (ev.key === 'Escape') {
        committed = true;
        if (textInput.parentNode) textInput.parentNode.removeChild(textInput);
      }
    });
    textInput.addEventListener('blur', commitText);
    return;
  }

  isDrawing = true;
  drawStart = redactCanvasPoint(e);
});

redactCanvas.addEventListener('mousemove', (e) => {
  if (!isDrawing || currentTool === 'text') return;
  const pt = redactCanvasPoint(e);
  redrawBase();
  redactCtx.strokeStyle = annotationColor;
  redactCtx.fillStyle   = annotationColor;
  redactCtx.lineWidth   = 4;

  if (currentTool === 'rect') {
    redactCtx.strokeRect(drawStart.x, drawStart.y, pt.x - drawStart.x, pt.y - drawStart.y);
  } else if (currentTool === 'arrow') {
    drawArrow(redactCtx, drawStart.x, drawStart.y, pt.x, pt.y);
  } else if (currentTool === 'blur') {
    redactCtx.save();
    redactCtx.setLineDash([6, 4]);
    redactCtx.strokeStyle = 'rgba(255,255,255,0.8)';
    redactCtx.strokeRect(drawStart.x, drawStart.y, pt.x - drawStart.x, pt.y - drawStart.y);
    redactCtx.restore();
  }
});

redactCanvas.addEventListener('mouseup', (e) => {
  if (!isDrawing || currentTool === 'text') return;
  isDrawing = false;
  const pt = redactCanvasPoint(e);
  redrawBase();
  redactCtx.strokeStyle = annotationColor;
  redactCtx.fillStyle   = annotationColor;
  redactCtx.lineWidth   = 4;

  if (currentTool === 'rect') {
    redactCtx.strokeRect(drawStart.x, drawStart.y, pt.x - drawStart.x, pt.y - drawStart.y);
    commitAnnotation();
  } else if (currentTool === 'arrow') {
    drawArrow(redactCtx, drawStart.x, drawStart.y, pt.x, pt.y);
    commitAnnotation();
  } else if (currentTool === 'blur') {
    applyBlur(redactCtx, drawStart.x, drawStart.y, pt.x - drawStart.x, pt.y - drawStart.y);
    commitAnnotation();
  }
});

redactCanvas.addEventListener('mouseleave', () => {
  if (isDrawing && currentTool !== 'text') {
    isDrawing = false;
    redrawBase();
  }
});

redactModalOverlay.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTool = btn.dataset.tool;
    redactModalOverlay.querySelectorAll('.tool-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
  });
});

function setAnnotationColor(hex) {
  annotationColor = hex;
  redactModalOverlay.querySelectorAll('.color-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.color === hex));
  document.getElementById('custom-color').value = hex;
}

redactModalOverlay.querySelectorAll('.color-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => setAnnotationColor(swatch.dataset.color));
});

document.getElementById('custom-color').addEventListener('input', (e) => {
  annotationColor = e.target.value;
  redactModalOverlay.querySelectorAll('.color-swatch').forEach(s =>
    s.classList.remove('active'));
});

btnUndoAnnotation.addEventListener('click', () => {
  if (redactHistory.length === 0) return;
  redactBaseImage = redactHistory.pop();
  redactCtx.putImageData(redactBaseImage, 0, 0);
  btnUndoAnnotation.disabled = redactHistory.length === 0;
});

btnCancelAnnotation.addEventListener('click', () => {
  redactModalOverlay.setAttribute('hidden', '');
  redactIndex = -1;
});

btnDoneAnnotation.addEventListener('click', () => {
  if (redactIndex < 0) return;
  guide.steps[redactIndex].screenshotDataUrl = redactCanvas.toDataURL();
  redactModalOverlay.setAttribute('hidden', '');
  redactIndex = -1;
  renderSteps();
});

// ── Confluence modal ───────────────────────────────────────────────────────

const CF_PREFS_KEY = 'flo_confluence_prefs';

function loadConfluencePrefs() {
  try {
    return JSON.parse(localStorage.getItem(CF_PREFS_KEY) || 'null');
  } catch { return null; }
}

function saveConfluencePrefs() {
  localStorage.setItem(CF_PREFS_KEY, JSON.stringify({
    baseUrl:  cfBaseUrl.value.trim(),
    spaceKey: cfSpaceKey.value.trim(),
    email:    cfEmail.value.trim()
  }));
}

btnCfCancel.addEventListener('click', () => {
  confluenceModalOverlay.setAttribute('hidden', '');
});

btnCfSubmit.addEventListener('click', async () => {
  cfResult.innerHTML = '';
  btnCfSubmit.disabled = true;
  btnCfSubmit.textContent = 'Exporting…';

  saveConfluencePrefs();

  const result = await window.flo.exportConfluence({
    guideId:   guide.id,
    baseUrl:   cfBaseUrl.value.trim(),
    spaceKey:  cfSpaceKey.value.trim(),
    email:     cfEmail.value.trim(),
    token:     cfToken.value,
    pageTitle: cfPageTitle.value.trim() || guide.title
  });

  btnCfSubmit.disabled = false;
  btnCfSubmit.textContent = 'Export';

  if (result.ok) {
    cfResult.innerHTML = `<div class="modal-success">
      ✓ Exported successfully.
      <a href="${result.pageUrl}" target="_blank" rel="noopener">Open page →</a>
    </div>`;
  } else {
    cfResult.innerHTML = `<div class="modal-error">
      Export failed: ${escapeHtml(result.message || result.reason || 'Unknown error')}
    </div>`;
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────

init();
