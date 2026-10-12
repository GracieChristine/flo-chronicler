// My Guides list screen.
// Open → read-only view. Edit mode is accessible from inside the editor.

const guidesList = document.getElementById('guides-list');

// ── Styled confirm dialog ──────────────────────────────────────────────────
// Returns a Promise resolving to true (OK) or false (Cancel).
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

// Format a date using the user's OS locale so day/month order is correct
// for UK/EU (DD/MM/YYYY) as well as US (MM/DD/YYYY). Seconds are omitted.
function formatDate(iso) {
  if (!iso) return 'Unknown date';
  return new Date(iso).toLocaleString(undefined, {
    year:   'numeric',
    month:  'numeric',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

async function render() {
  const guides = await window.flo.listGuides();

  if (guides.length === 0) {
    guidesList.innerHTML = `
      <p class="guides-empty">No guides yet. Start a new recording to create your first one.</p>`;
    return;
  }

  guidesList.innerHTML = guides.map(g => {
    const date = formatDate(g.updatedAt);
    const isDraft = g.version === 0;
    const versionLabel = isDraft
      ? `<span class="guide-row-draft">Draft</span>`
      : `<span class="guide-row-version">v${g.version}.0</span>`;
    return `
      <div class="guide-row" data-id="${escapeAttr(g.id)}">
        <div class="guide-row-info">
          <span class="guide-row-title">${escapeHtml(g.title || 'Untitled guide')}</span>
          <span class="guide-row-meta">
            ${versionLabel}
            &nbsp;Updated ${escapeHtml(date)}
          </span>
        </div>
        <div class="guide-row-actions">
          <button class="btn btn-primary btn-open"
                  data-id="${escapeAttr(g.id)}"
                  data-draft="${isDraft}">Open</button>
          <button class="btn btn-secondary btn-delete" data-id="${escapeAttr(g.id)}">Delete</button>
        </div>
      </div>`;
  }).join('');

  // Open → edit mode for drafts, view/read-only for published guides
  guidesList.querySelectorAll('.btn-open').forEach(btn => {
    btn.addEventListener('click', () => {
      const editParam = btn.dataset.draft === 'true' ? '&edit=1' : '';
      window.location.href = `editor.html?id=${encodeURIComponent(btn.dataset.id)}${editParam}`;
    });
  });

  // Delete
  guidesList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const title = btn.closest('.guide-row').querySelector('.guide-row-title').textContent;
      const ok = await showConfirm(
        `"${title}" will be permanently deleted. This cannot be undone.`,
        { title: 'Delete guide?', okLabel: 'Delete', cancelLabel: 'Cancel' }
      );
      if (!ok) return;
      await window.flo.deleteGuide(btn.dataset.id);
      await render();
    });
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}

render();
