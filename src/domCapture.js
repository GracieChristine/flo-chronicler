// Element labeling and metadata extraction for the recorder.
// Dual-mode export: works via require() (preload-webview.js) or as a plain
// <script> tag with no module system (for ad-hoc testing pages).

// ── SVG & leaf tag classification ────────────────────────────────────────────
// These elements carry no useful semantic meaning on their own; clicking one
// almost always means the user intended to click a parent interactive element
// (a button, link, or labelled container that wraps the icon/shape).
const SVG_LEAF_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'ellipse', 'g', 'use', 'defs', 'stop', 'lineargradient',
  'radialgradient', 'clippath', 'mask', 'symbol', 'tspan',
  // Inline presentational elements — same issue: label lives on the parent
  'i', 'em', 'strong', 'picture'
]);

// Semantic landmark / block elements at which we always stop walking up.
// Going further would reach <body> whose innerText is the whole page — useless.
const LANDMARK_TAGS = new Set([
  'main', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'form',
  'canvas'  // canvas content is not in the DOM; walking past it gives page noise
]);

// Interactive tags & roles: stop walking here because this IS the target.
const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea',
  'details', 'summary', 'label'
]);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'gridcell'
]);

// Returns true when bestLabel would produce something useful rather than falling
// back to the raw tag name. Used to decide whether to keep walking up the tree.
function hasUsefulLabel(el) {
  const tag   = (el.tagName || '').toLowerCase();
  const label = bestLabel(el);
  return label.length > 0 && label !== tag && label !== 'element';
}

// Walk up the DOM to find the element the user actually "meant" to click.
// Handles SVG icons, canvas, empty icon-font spans, and other "leaf" nodes
// where the semantically meaningful target is a parent button / link / container.
function effectiveTarget(el) {
  let cur = el;

  for (let depth = 0; depth < 10; depth++) {
    if (!cur || cur === document.body || cur === document.documentElement) return el;

    const tag  = (cur.tagName || '').toLowerCase();
    const role = cur.getAttribute ? cur.getAttribute('role') : null;

    // Always stop at explicitly interactive elements — they ARE the target
    if (INTERACTIVE_TAGS.has(tag)) return cur;
    if (role && INTERACTIVE_ROLES.has(role)) return cur;

    // Known visual-only SVG leaves — always walk up regardless of content
    if (SVG_LEAF_TAGS.has(tag)) { cur = cur.parentElement; continue; }

    // <svg> and <canvas> — walk up unless they carry their own meaningful label
    if (tag === 'svg' || tag === 'canvas') {
      if (hasUsefulLabel(cur)) return cur;
      cur = cur.parentElement;
      continue;
    }

    // Semantic landmarks and canvas: always stop here.
    // Their innerText spans entire page regions, so walking further gives noise
    // rather than a meaningful description. bestLabel will prefer aria-label/title
    // over innerText for these tags.
    if (LANDMARK_TAGS.has(tag)) return cur;

    // Everything else (div, span, li, p, …): stop here only if this element
    // has a useful label. Empty icon-font spans, badge wrappers, etc. will have
    // no text/aria-label, so we keep walking until we find something meaningful.
    if (hasUsefulLabel(cur)) return cur;
    cur = cur.parentElement;
  }

  return el; // fallback if we hit MAX_DEPTH
}

// ── Label extraction ──────────────────────────────────────────────────────────

function bestLabel(el) {
  // 1. aria-label
  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // 2. aria-labelledby → resolve to the referenced element's text
  const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) {
      const t = (refEl.innerText || refEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 60 ? t.slice(0, 60) + '...' : t;
    }
  }

  // 3. title attribute
  const titleAttr = el.getAttribute && el.getAttribute('title');
  if (titleAttr && titleAttr.trim()) return titleAttr.trim();

  // 4. innerText/textContent — skip body/html and landmark/canvas tags.
  //    Landmark elements contain entire page regions; their innerText is too
  //    broad to be a useful label (e.g. the whole canvas area's accessible tree).
  const tag = (el.tagName || '').toLowerCase();
  const skipInnerText = tag === 'body' || tag === 'html' || LANDMARK_TAGS.has(tag);
  if (!skipInnerText) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 60 ? text.slice(0, 60) + '...' : text;
  }

  // 5. placeholder (inputs)
  const placeholder = el.getAttribute && el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  // 6. name attribute
  const name = el.getAttribute && el.getAttribute('name');
  if (name && name.trim()) return name.trim();

  // 7. alt text (images)
  const alt = el.getAttribute && el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();

  // 8. data-testid or id — last resort readable identifiers
  const testId = el.getAttribute && el.getAttribute('data-testid');
  if (testId && testId.trim()) return testId.trim();

  // 9. fallback: lowercased tag name
  return tag || 'element';
}

function looksLikeButton(el) {
  if (!el.classList) return false;
  for (const cls of el.classList) {
    if (/^(btn|button)([-_].*)?$/i.test(cls)) return true;
  }
  return false;
}

// ── Metadata extraction ───────────────────────────────────────────────────────

function elementMetadata(el, clickX, clickY) {
  // Walk up from SVG leaves / canvas to the semantically meaningful target
  const target = effectiveTarget(el);
  const tag    = (target.tagName || '').toLowerCase();
  const rect   = target.getBoundingClientRect
    ? target.getBoundingClientRect()
    : { x: 0, y: 0, width: 0, height: 0 };

  return {
    tag,
    type:            target.getAttribute ? target.getAttribute('type') : null,
    role:            target.getAttribute ? target.getAttribute('role') : null,
    ariaPressed:     target.getAttribute ? target.getAttribute('aria-pressed') : null,
    looksLikeButton: looksLikeButton(target),
    label:           bestLabel(target),
    boundingRect:    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    clickPoint:      { x: clickX, y: clickY },
    pageTitle:       document.title,
    pageUrl:         window.location.href,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

// ── Text-entry detection ──────────────────────────────────────────────────────
// Used to decide whether to re-capture the screenshot after the user has typed
// (showing the filled value rather than the empty field at click time).

function isTextEntryElement(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    const nonText = ['checkbox', 'radio', 'submit', 'button', 'file', 'range', 'color', 'image', 'reset'];
    return !nonText.includes(type);
  }
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = { bestLabel, looksLikeButton, effectiveTarget, elementMetadata, isTextEntryElement };
} else {
  window.domCapture = { bestLabel, looksLikeButton, effectiveTarget, elementMetadata, isTextEntryElement };
}
