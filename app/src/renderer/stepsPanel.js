// Recorder step-list rendering. Shared: app.js + preview harness.
// Dual-mode export: works via require() or as a plain <script> tag (window-global).

function escapeHtml(str) {
  // Standard browser-native HTML-escaping trick: no regex needed
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderStepsListHtml(groups) {
  if (!groups || groups.length === 0) {
    return '<p class="steps-empty">Steps will appear here as you click through your walkthrough.</p>';
  }

  return groups.map((group, i) => {
    const screenshot = window.stepGroups.groupScreenshot(group);
    const text = window.stepGroups.groupText(group);

    const imgHtml = screenshot
      ? `<img src="${screenshot}" alt="Step ${i + 1}" class="step-card-img" />`
      : `<div class="step-card-noimg" title="Screenshot unavailable — it likely navigated to a new page before the capture finished">No screenshot</div>`;

    return `
      <div class="step-card">
        ${imgHtml}
        <div class="step-card-body">
          <span class="step-num">${i + 1}</span>
          <p class="step-card-text">${escapeHtml(text)}</p>
        </div>
      </div>`;
  }).join('');
}

if (typeof module !== 'undefined') {
  module.exports = { renderStepsListHtml };
} else {
  window.stepsPanel = { renderStepsListHtml };
}
