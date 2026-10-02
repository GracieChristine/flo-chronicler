// Runs inside the recorded webpage in an isolated world.
// Can read the page's DOM; the page's own scripts cannot see or tamper with this.
// Never has Node/filesystem access — enforced by main.js's will-attach-webview handler.
// Communicates back to the host via ipcRenderer.sendToHost (the webview→embedder channel).
//
// NOTE: domCapture logic is inlined here (not require'd) to avoid ASAR path resolution
// issues in packaged builds. If require('./domCapture') fails silently in a webview
// preload context, no listeners get registered and recording is completely broken.

const { ipcRenderer } = require('electron');

// ── Top-level state ───────────────────────────────────────────────────────────
// Declared here (before any event handlers) to avoid temporal dead zone errors.
// Third-party scripts (Pendo, analytics) send postMessage events immediately on
// page load — our message handler must be able to read these variables safely.
let recording    = false;
let stepSeq      = 0;
let pageProfile  = 'webApp';
let designNodes  = null;

console.log('[flo] preload-webview.js loaded — url:', window.location.href);

// ── Inlined domCapture helpers (keep in sync with src/domCapture.js) ─────────

const SVG_LEAF_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'ellipse', 'g', 'use', 'defs', 'stop', 'lineargradient',
  'radialgradient', 'clippath', 'mask', 'symbol', 'tspan',
  'i', 'em', 'strong', 'picture'
]);
const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'details', 'summary', 'label'
]);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'gridcell'
]);
// Landmark/block elements at which we always stop walking up the DOM.
// Going further reaches <body> whose innerText is the whole page — useless as a label.
const LANDMARK_TAGS = new Set([
  'main', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'form',
  'canvas'
]);

// Returns true when bestLabel produces something meaningful (not just the tag name).
// Used by effectiveTarget to decide whether to keep walking up the DOM.
function hasUsefulLabel(el) {
  const tag   = (el.tagName || '').toLowerCase();
  const label = bestLabel(el);
  return label.length > 0 && label !== tag && label !== 'element';
}

function effectiveTarget(el) {
  let cur = el;
  for (let depth = 0; depth < 10; depth++) {
    if (!cur || cur === document.body || cur === document.documentElement) return el;
    const tag  = (cur.tagName || '').toLowerCase();
    const role = cur.getAttribute ? cur.getAttribute('role') : null;
    // Always stop at explicitly interactive elements
    if (INTERACTIVE_TAGS.has(tag)) return cur;
    if (role && INTERACTIVE_ROLES.has(role)) return cur;
    // Known visual-only SVG leaves — always walk up
    if (SVG_LEAF_TAGS.has(tag)) { cur = cur.parentElement; continue; }
    // <svg>: stop only if it carries a meaningful label
    if (tag === 'svg') {
      if (hasUsefulLabel(cur)) return cur;
      cur = cur.parentElement;
      continue;
    }
    // Semantic landmarks and canvas: always stop here to avoid page-level noise.
    if (LANDMARK_TAGS.has(tag)) return cur;
    // Everything else (div, span, li, p, …): stop only if there's a useful label.
    // Empty icon-font spans and unlabelled wrappers will have no label, so we
    // keep walking until we reach something meaningful.
    if (hasUsefulLabel(cur)) return cur;
    cur = cur.parentElement;
  }
  return el;
}

function bestLabel(el) {
  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) {
      const t = (refEl.innerText || refEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 60 ? t.slice(0, 60) + '...' : t;
    }
  }

  const titleAttr = el.getAttribute && el.getAttribute('title');
  if (titleAttr && titleAttr.trim()) return titleAttr.trim();

  const tag = (el.tagName || '').toLowerCase();
  const skipInnerText = tag === 'body' || tag === 'html' || LANDMARK_TAGS.has(tag);
  if (!skipInnerText) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 60 ? text.slice(0, 60) + '...' : text;
  }

  const placeholder = el.getAttribute && el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  const name = el.getAttribute && el.getAttribute('name');
  if (name && name.trim()) return name.trim();

  const alt = el.getAttribute && el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();

  const testId = el.getAttribute && el.getAttribute('data-testid');
  if (testId && testId.trim()) return testId.trim();

  return tag || 'element';
}

function looksLikeButton(el) {
  if (!el.classList) return false;
  for (const cls of el.classList) {
    if (/^(btn|button)([-_].*)?$/i.test(cls)) return true;
  }
  return false;
}

function elementMetadata(el, clickX, clickY) {
  const target = effectiveTarget(el);
  const tag    = (target.tagName || '').toLowerCase();
  const rect   = target.getBoundingClientRect
    ? target.getBoundingClientRect()
    : { x: 0, y: 0, width: 0, height: 0 };
  return {
    tag,
    type:            target.getAttribute ? target.getAttribute('type') : null,
    role:            target.getAttribute ? target.getAttribute('role') : null,
    // aria-pressed presence (even "false") signals a toggle/tool button
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

// ── Iframe click capture ──────────────────────────────────────────────────────
// Some apps render their entire UI inside a blank <iframe> (no src attribute).
// Our preload only runs in the top-level document, so clicks inside the iframe
// are invisible to us. Fix: inject a silent observer script into same-origin
// iframes. It does NOT modify any visible content — pure event listening.
//
// The injected script sends click metadata up via postMessage; this preload
// receives it and processes it identically to a direct top-frame click.

// Self-contained click observer script injected into each same-origin iframe.
// Kept as a plain string so it runs in the iframe's JS context (not ours).
const IFRAME_OBSERVER_SCRIPT = `(function () {
  if (window.__floInjected) return;
  window.__floInjected = true;

  var SVG_LEAVES = ['path','circle','rect','line','polyline','polygon','ellipse',
    'g','use','defs','stop','i','em','strong','picture','tspan'];
  var INTERACTIVE = ['a','button','input','select','textarea','label'];
  var ROLES = ['button','link','menuitem','menuitemcheckbox','menuitemradio',
    'tab','option','checkbox','radio','switch','treeitem','gridcell'];

  function getLabel(el) {
    var a = el.getAttribute && el.getAttribute('aria-label');
    if (a && a.trim()) return a.trim();
    var t = el.getAttribute && el.getAttribute('title');
    if (t && t.trim()) return t.trim();
    var tag = (el.tagName || '').toLowerCase();
    if (tag !== 'body' && tag !== 'html') {
      var txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (txt) return txt.length > 60 ? txt.slice(0, 60) + '...' : txt;
    }
    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    return tag || 'element';
  }

  function effectiveTarget(el) {
    var cur = el;
    for (var d = 0; d < 10; d++) {
      if (!cur || cur === document.body) return el;
      var tag = (cur.tagName || '').toLowerCase();
      var role = cur.getAttribute && cur.getAttribute('role');
      if (INTERACTIVE.indexOf(tag) >= 0) return cur;
      if (role && ROLES.indexOf(role) >= 0) return cur;
      if (SVG_LEAVES.indexOf(tag) >= 0) { cur = cur.parentElement; continue; }
      var lbl = getLabel(cur);
      if (lbl && lbl !== tag && lbl !== 'element') return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el) return;
    var target = effectiveTarget(el);
    var tag = (target.tagName || '').toLowerCase();
    var stepToken = Date.now() + '_' + Math.random();

    // For canvas elements, record the canvas-relative click position in CSS pixels.
    // The preload will apply the Konva stage transform to convert to design coords.
    var designCoords = null;
    if (tag === 'canvas') {
      var cr = target.getBoundingClientRect();
      if (cr.width > 0 && cr.height > 0) {
        designCoords = { x: e.clientX - cr.left, y: e.clientY - cr.top };
      }
    }

    window.top.postMessage({
      __flo: true, type: 'flo:iframe-click', stepToken: stepToken,
      meta: {
        tag:              tag,
        type:             target.getAttribute ? target.getAttribute('type') : null,
        role:             target.getAttribute ? target.getAttribute('role') : null,
        ariaPressed:      target.getAttribute ? target.getAttribute('aria-pressed') : null,
        label:            getLabel(target),
        isContentEditable: !!target.isContentEditable,
        clickPoint:       { x: e.clientX, y: e.clientY },
        designCoords:     designCoords,
        pageTitle:        document.title,
        pageUrl:          window.location.href,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    }, '*');

    // Re-capture on focusout for text fields and contenteditable
    var isText = tag === 'textarea' || target.isContentEditable ||
      (tag === 'input' && ['checkbox','radio','submit','button','file','range',
        'color','image','reset'].indexOf(
          (target.getAttribute('type') || 'text').toLowerCase()) < 0);
    if (isText) {
      target.addEventListener('focusout', function () {
        window.top.postMessage({
          __flo: true, type: 'flo:iframe-recapture', stepToken: stepToken,
          meta: {
            tag: tag,
            type: target.getAttribute ? target.getAttribute('type') : null,
            label: getLabel(target),
            clickPoint: { x: e.clientX, y: e.clientY },
            pageUrl: window.location.href
          }
        }, '*');
      }, { once: true });
    }
  }, true);
})();`;

// Attempt to inject the observer into a same-origin iframe.
// Cross-origin iframes will throw on contentDocument access — caught silently.
function injectIntoIframe(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.head) return;
    if (iframe.contentWindow && iframe.contentWindow.__floInjected) return;
    const script = doc.createElement('script');
    script.textContent = IFRAME_OBSERVER_SCRIPT;
    doc.head.appendChild(script);
    // Re-run profile detection now that the iframe has content — it may have been
    // empty when detectProfile() ran at DOMContentLoaded / 600ms / 2000ms.
    if (typeof detectProfile === 'function') {
      pageProfile = detectProfile();
      console.log('[flo] injectIntoIframe — re-detected profile:', pageProfile,
        '| canvas in iframe:', doc.querySelectorAll('canvas').length);
      // If this is a design-tool page, fetch element layout now (best timing: right
      // after the iframe is confirmed to contain a canvas).
      if (pageProfile === 'canvasTool' && !designNodes && typeof fetchAndCacheDesign === 'function') {
        fetchAndCacheDesign();
      }
    }
  } catch (_) { /* cross-origin or CSP blocked — skip */ }
}

// Maps iframe stepToken → stepId so recapture messages can be correlated.
// The injected script generates a unique token per click; we assign the real
// stepId in the parent preload and remember the mapping here.
const iframeTokenToStepId = new Map();

// Receive click reports from injected iframes and process them like direct clicks.
window.addEventListener('message', async (event) => {
  if (!recording) return;
  if (!event.data || !event.data.__flo) return; // ignore unrelated postMessages

  if (event.data.type === 'flo:iframe-click') {
    const stepId = ++stepSeq;
    // Remember this token so the matching recapture can find the right stepId
    iframeTokenToStepId.set(event.data.stepToken, stepId);
    const meta = { ...event.data.meta, stepId, profile: pageProfile };
    if (pageProfile === 'canvasTool' && meta.tag === 'canvas') {
      meta.activeTool = findActiveTool();
      await enrichCanvasMeta(meta); // hit-test against design API layout
    }
    ipcRenderer.sendToHost('flo:click', meta);

  } else if (event.data.type === 'flo:iframe-recapture') {
    // Look up the stepId that was assigned when the click was first captured
    const stepId = iframeTokenToStepId.get(event.data.stepToken);
    if (stepId === undefined) return; // stale or unknown token — ignore
    iframeTokenToStepId.delete(event.data.stepToken); // clean up
    ipcRenderer.sendToHost('flo:recapture', { ...event.data.meta, stepId });
  }
});

// Watch for iframes added dynamically (SPAs inject them after load)
const iframeObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'IFRAME') {
        node.contentDocument && node.contentDocument.readyState !== 'loading'
          ? injectIntoIframe(node)
          : node.addEventListener('load', () => injectIntoIframe(node));
      }
      // Catch iframes nested inside newly-added subtrees
      if (node.querySelectorAll) {
        node.querySelectorAll('iframe').forEach(f =>
          f.contentDocument && f.contentDocument.readyState !== 'loading'
            ? injectIntoIframe(f)
            : f.addEventListener('load', () => injectIntoIframe(f))
        );
      }
    }
  }
});

function startIframeObserver() {
  iframeObserver.observe(document.documentElement, { childList: true, subtree: true });
  // Handle iframes that already exist at preload time
  document.querySelectorAll('iframe').forEach(iframe => {
    iframe.contentDocument && iframe.contentDocument.readyState !== 'loading'
      ? injectIntoIframe(iframe)
      : iframe.addEventListener('load', () => injectIntoIframe(iframe));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startIframeObserver);
} else {
  startIframeObserver();
}

// ── Page profile auto-detection ───────────────────────────────────────────────
// Classifies the current page so recording can enrich step descriptions with
// context-appropriate detail. Runs silently — user never sees this.

// pageProfile declared at top of file — see "Top-level state" section

function detectProfile() {
  // ── Highest-priority check: blank same-origin iframe containing a canvas ──
  // Some apps (e.g. Poppulo) inject their entire design tool into a blank <iframe>
  // with no src attribute. getBoundingClientRect() on cross-frame elements is
  // unreliable, so we use presence alone: any blank iframe with a canvas = design tool.
  const allIframes = document.querySelectorAll('iframe');
  for (const f of allIframes) {
    try {
      const doc = f.contentDocument;
      if (doc && doc.querySelector('canvas')) return 'canvasTool';
    } catch { /* cross-origin — skip */ }
  }

  // Canvas / design tool: a large <canvas> dominates the top-level viewport
  const canvases = Array.from(document.querySelectorAll('canvas'));
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    if (r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.3) {
      return 'canvasTool';
    }
  }

  // Dashboard: several chart canvases or SVG elements (but none individually huge)
  const svgs = document.querySelectorAll('svg');
  if (canvases.length >= 2 || svgs.length >= 3) return 'dashboard';

  // Rich text / document editor: a large contenteditable area
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
  for (const e of editables) {
    const r = e.getBoundingClientRect();
    if (r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.25) {
      return 'richText';
    }
  }

  // Data grid: explicit ARIA grid role, or a large multi-column table
  if (document.querySelector('[role="grid"], [role="treegrid"]')) return 'dataGrid';
  const tables = Array.from(document.querySelectorAll('table'));
  const bigTable = tables.find(t =>
    t.querySelectorAll('th').length > 4 && t.querySelectorAll('tr').length > 8
  );
  if (bigTable) return 'dataGrid';

  // Form / wizard: more than half of interactive elements are form inputs
  const inputs      = document.querySelectorAll('input:not([type=hidden]), select, textarea');
  const interactive = document.querySelectorAll('a, button, [role=button], input, select, textarea');
  if (inputs.length > 4 && inputs.length / Math.max(interactive.length, 1) > 0.5) {
    return 'formWizard';
  }

  return 'webApp';
}

// Run detection after DOMContentLoaded so dynamic content has a chance to render.
// Also schedule re-checks at 600ms, 2000ms, and 5000ms — SPAs and blank iframes
// may inject canvas content well after the initial load event.
// When a canvasTool page is confirmed, kick off the design element fetch.
function runDetection() {
  const p0 = detectProfile();
  console.log('[flo] detectProfile @0ms:', p0, '| iframes:', document.querySelectorAll('iframe').length);
  pageProfile = p0;

  [600, 2000, 5000, 10000].forEach(delay => {
    setTimeout(() => {
      const iframes  = document.querySelectorAll('iframe');
      const canvases = document.querySelectorAll('canvas');
      const canvasInfo = Array.from(canvases).map(c => {
        const r = c.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}`;
      });
      const shadowHosts = document.querySelectorAll('*');
      let shadowCanvases = 0;
      shadowHosts.forEach(el => {
        if (el.shadowRoot) shadowCanvases += el.shadowRoot.querySelectorAll('canvas').length;
      });

      console.log(`[flo] @${delay}ms — iframes:${iframes.length} canvases:${canvases.length}[${canvasInfo}] shadowCanvases:${shadowCanvases}`);

      const p = detectProfile();
      pageProfile = p;
      console.log(`[flo] @${delay}ms — profile: ${p}`);
      if (pageProfile === 'canvasTool') {
        injectKonvaReader(); // inject Konva hit-tester into page context
      }
    }, delay);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runDetection);
} else {
  runDetection();
}

// Also watch for canvas elements being added dynamically (SPAs render late).
// When we see the first canvas appear, immediately re-run detection so we
// don't have to wait for the 5-second scheduled check.
(function watchForCanvas() {
  if (document.querySelector('canvas')) return; // already present
  const obs = new MutationObserver(() => {
    if (!document.querySelector('canvas')) return;
    obs.disconnect();
    const p = detectProfile();
    console.log('[flo] canvas appeared — re-detected profile:', p);
    pageProfile = p;
    if (pageProfile === 'canvasTool') injectKonvaReader();
  });
  // documentElement may be null if the preload runs before <html> is parsed.
  // Fall back to document itself (also a Node) which is always available.
  const target = document.documentElement || document;
  try {
    obs.observe(target, { childList: true, subtree: true });
  } catch (e) {
    // Last resort: wait for DOMContentLoaded and try again
    document.addEventListener('DOMContentLoaded', () => {
      try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
    });
  }
})();

// ── Active tool detection (canvas / design tools) ─────────────────────────────
// When the page profile is canvasTool, try to read which drawing tool is
// currently selected — gives us "Use the Rectangle tool" instead of "Click on the canvas."

function findActiveTool() {
  // aria-pressed="true" is the standard for toolbar toggle buttons (Figma, Canva, etc.)
  const pressed = document.querySelector('[aria-pressed="true"]');
  if (pressed) {
    const lbl = bestLabel(pressed);
    if (lbl && lbl !== (pressed.tagName || '').toLowerCase()) return lbl;
  }

  // Fallback: common CSS class patterns for active/selected tool buttons
  const selectors = [
    '[data-tool].active', '[data-tool].selected', '[data-tool].is-active',
    '[data-testid*="tool"].active', '[data-testid*="tool"].selected',
    '.tool-btn.active', '.tool-btn.selected',
    '.toolbar-btn.active', '.toolbar-item.active', '.toolbar-item--active'
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const lbl = bestLabel(el);
        if (lbl && lbl !== (el.tagName || '').toLowerCase()) return lbl;
      }
    } catch { /* invalid selector — skip */ }
  }

  return null;
}

// ── Design element hit-testing (Poppulo canvas) ───────────────────────────────
// The Poppulo backend exposes a /download API that returns the full element
// layout for the current design (nodes with x, y, width, height, type, etc.).
// We fetch this once and cache it. On every canvas click we convert the screen
// click to design-space coordinates and find which element was clicked —
// giving us "Click the 'Title' text element" instead of "Click on the canvas."

// designNodes declared at top of file — see "Top-level state" section

// Flatten the top-level nodes array, resolving child element positions to
// absolute design coordinates. Handles dataSource containers with nested nodes.
function flattenNodes(nodes, offsetX, offsetY) {
  offsetX = offsetX || 0;
  offsetY = offsetY || 0;
  const result = [];
  for (const node of nodes) {
    const abs = Object.assign({}, node, {
      _ax: (node.x || 0) + offsetX,
      _ay: (node.y || 0) + offsetY
    });
    result.push(abs);
    if (Array.isArray(node.nodes)) {
      const children = flattenNodes(node.nodes, abs._ax, abs._ay);
      for (const c of children) result.push(c);
    }
  }
  return result;
}

// Rotation-aware point-in-rectangle test.
// Konva rotates around the element's center; we un-rotate the click point
// and check against the axis-aligned half-dimensions.
function hitTestNode(node, dx, dy) {
  if (node.visible === false) return false; // skip only if explicitly hidden
  const w = (node.width  || 0) * (node.scaleX || 1);
  const h = (node.height || 0) * (node.scaleY || 1);
  if (w <= 0 && h <= 0) return false;

  const cx = node._ax + (node.width  || 0) / 2;
  const cy = node._ay + (node.height || 0) / 2;

  let lx = dx - cx;
  let ly = dy - cy;

  if (node.rotation) {
    const rad = -node.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx  = lx * cos - ly * sin;
    const ry  = lx * sin + ly * cos;
    lx = rx;
    ly = ry;
  }

  if (node.type === 'ellipse') {
    const rx = node.radiusX || w / 2;
    const ry = node.radiusY || h / 2;
    if (rx <= 0 || ry <= 0) return false;
    return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
  }

  // Line: use stroke width + a generous buffer since lines are thin
  if (node.type === 'line') {
    return Math.abs(lx) <= w / 2 + 8 && Math.abs(ly) <= Math.max(h / 2, (node.strokeWidth || 2) / 2 + 8);
  }

  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
}

// Human-readable label for a design node.
function labelForNode(node) {
  if (node.type === 'text' || node.type === 'datetime') {
    // Use actual text content when available (most descriptive)
    const t = (node.text || '').trim();
    return t.length > 0 ? t.slice(0, 40) + (t.length > 40 ? '…' : '') : node.name || 'text';
  }
  // For other types use name (e.g. "rectangle-1") or fall back to type
  return node.name || node.type || 'element';
}

// Type → readable kind string for use in step descriptions
function kindForNode(node) {
  const kinds = {
    'text':       'text element',
    'image':      'image',
    'rectangle':  'rectangle',
    'ellipse':    'ellipse',
    'line':       'line',
    'dataSource': 'data source block',
    'datetime':   'date/time element',
    'qrCode':     'QR code',
    'logo':       'logo',
    'data/field': 'data field',
    'data/image': 'data image'
  };
  return kinds[node.type] || node.type || 'element';
}

// Find the topmost visible node at design coordinates (dx, dy).
// Nodes are stored in render order; we search in reverse for topmost hit.
function findHitNode(dx, dy) {
  if (!designNodes) return null;
  for (let i = designNodes.length - 1; i >= 0; i--) {
    if (hitTestNode(designNodes[i], dx, dy)) return designNodes[i];
  }
  // Debug: log all nodes with their bounds so we can see why nothing was hit
  console.log('[flo] no hit at design coords', Math.round(dx), Math.round(dy),
    '— nodes:', designNodes.map(n =>
      `${n.type}(${Math.round(n._ax)},${Math.round(n._ay)} ${Math.round(n.width||0)}x${Math.round(n.height||0)} vis=${n.visible})`
    ).join(' | ')
  );
  return null;
}

// ── Konva hit-tester ──────────────────────────────────────────────────────────
// Poppulo uses Konva.js. Konva maintains its own hidden hit-detection canvas and
// exposes stage.getIntersection({x,y}) which returns the exact shape under a point —
// handling all zoom/pan/rotation transforms automatically.
//
// We can't access window.Konva from the isolated preload world, so we inject a
// tiny non-visual script into the page context. It listens for our postMessage
// requests, does the hit-test using Konva's own API, and posts the result back.
// No backend API, no manual coordinate math — Konva does it all.

let konvaTransformReady = false;

function injectKonvaReader() {
  if (konvaTransformReady) return;
  try {
    const script = document.createElement('script');
    script.textContent = `(function () {
      if (window.__floKonva) return;
      window.__floKonva = true;
      window.addEventListener('message', function (e) {
        if (!e.data || !e.data.__flo) return;

        // ── Hit-test: ask Konva which shape is under canvas-relative coords ──
        if (e.data.__flo === 'konvaHitTest') {
          try {
            var stages = window.Konva && window.Konva.stages;
            if (!stages || !stages.length) {
              window.postMessage({ __flo: 'konvaHitResult', node: null }, '*'); return;
            }
            var stage = stages[0];
            var shape = stage.getIntersection({ x: e.data.x, y: e.data.y });
            if (!shape) {
              window.postMessage({ __flo: 'konvaHitResult', node: null }, '*'); return;
            }
            // Helper: check if a node is an internal Konva Transformer child
            // (anchors, back-rect, etc.). Transformer children should never be
            // returned as the hit — they're selection handles, not content.
            function isTransformerChild(node) {
              var p = node.parent;
              for (var d = 0; d < 6 && p; d++) {
                if (p.getClassName && p.getClassName() === 'Transformer') return true;
                p = p.parent;
              }
              return false;
            }

            // Name-based skip: background/container shapes inside data grid cells
            var SKIP_NAME = /background|container|border|cell/;

            function shouldSkip(node) {
              if (isTransformerChild(node)) return true;
              var n = (node.attrs && node.attrs.name) || '';
              return SKIP_NAME.test(n);
            }

            // If the primary hit should be skipped, use getAllIntersections to find
            // the best real content shape underneath.
            if (shouldSkip(shape)) {
              try {
                var all = stage.getAllIntersections({ x: e.data.x, y: e.data.y });
                var found = null;
                for (var ai = all.length - 1; ai >= 0; ai--) {
                  if (!shouldSkip(all[ai])) { found = all[ai]; break; }
                }
                if (found) shape = found;
                else { window.postMessage({ __flo: 'konvaHitResult', node: null }, '*'); return; }
              } catch (_) { /* getAllIntersections unavailable — keep original hit */ }
            }
            var className = shape.getClassName ? shape.getClassName() : 'Shape';
            var attrs = shape.attrs || {};
            var text = attrs.text || '';
            var name = attrs.name || attrs.id || '';
            // Collect names from all ancestor groups — widget type is usually on a parent
            var ancestorNames = [];
            var cur = shape.parent;
            var depth = 0;
            while (cur && depth < 8) {
              var cname = cur.getClassName ? cur.getClassName() : '';
              if (cname === 'Layer' || cname === 'Stage') break;
              var ca = cur.attrs || {};
              var aname = (ca.name || ca.id || '').trim();
              if (aname) ancestorNames.push(aname);
              if (!text && ca.text) text = ca.text;
              cur = cur.parent; depth++;
            }
            if (!name && ancestorNames.length) name = ancestorNames[0];
            window.postMessage({ __flo: 'konvaHitResult',
              node: { className: className, name: name, text: text, ancestorNames: ancestorNames }
            }, '*');
          } catch (err) {
            window.postMessage({ __flo: 'konvaHitResult', node: null }, '*');
          }
        }
      });
    })();`;
    document.head.appendChild(script);
    konvaTransformReady = true;
    console.log('[flo] Konva hit-tester injected');
  } catch (e) {
    console.warn('[flo] Could not inject Konva reader:', e.message);
  }
}

// Ask the injected Konva script to hit-test canvas-relative coords.
// Returns { className, name, text } describing the Konva shape, or null.
function getKonvaHit(x, y) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 200);
    function handler(event) {
      if (!event.data || event.data.__flo !== 'konvaHitResult') return;
      clearTimeout(timeout);
      window.removeEventListener('message', handler);
      resolve(event.data.node);
    }
    window.addEventListener('message', handler);
    window.postMessage({ __flo: 'konvaHitTest', x, y }, '*');
  });
}

// Map a Konva class name to a human-readable element kind.
function kindFromKonvaClass(className) {
  const map = {
    text:           'text element',
    rect:           'rectangle',
    ellipse:        'ellipse',
    circle:         'circle',
    line:           'line',
    arrow:          'arrow',
    image:          'image',
    path:           'shape',
    star:           'shape',
    wedge:          'shape',
    arc:            'shape',
    ring:           'shape',
    label:          'label',
    group:          'element',
    transformer:    null,   // ignore — Konva's selection box wrapper
    anchortransformer: null, // ignore — Konva resize/rotate handle anchors
    layer:          null
  };
  const k = map[className.toLowerCase()];
  return (k === undefined) ? 'element' : k; // null means "skip this shape"
}

// Apply Konva hit-test to a canvas click, populating meta.canvasElement.
// Uses Konva's own getIntersection() — handles all transforms automatically.
// Falls back gracefully to "click on the canvas" if Konva isn't available.
async function enrichCanvasMeta(meta) {
  if (meta.tag !== 'canvas') return;
  const coords = meta.designCoords;
  if (!coords) return;
  if (!konvaTransformReady) return;

  const konvaNode = await getKonvaHit(coords.x, coords.y);
  console.log('[flo] Konva hit:', konvaNode
    ? `${konvaNode.className} name="${konvaNode.name}" text="${konvaNode.text}" ancestors=[${(konvaNode.ancestorNames||[]).join(',')}]`
    : 'none');

  if (!konvaNode) return;

  const kind = kindFromKonvaClass(konvaNode.className);
  if (!kind) return; // transformer handles, layer nodes — ignore

  // Widget type detection — check ONLY the direct node name, not ancestors.
  // In Poppulo, widget names (datetime-1, qr-1, data-1) are set directly on the shape.
  // Using ancestor names here caused elements INSIDE a data source (e.g. text-3 inside
  // data-1) to be falsely identified as 'dataSource' because the ancestor matched.
  const directName = (konvaNode.name || '').toLowerCase();

  // Known widget type patterns — matched against the direct node name only.
  // Widget nodes should never use their dynamic text as a label.
  const WIDGET_PATTERNS = [
    { test: /datetime|date.?time|date_time|local.?time|effective.?time|local-effective-time|\btime-\d/, type: 'datetime', kind: 'date/time element' },
    { test: /qrcode|qr.?code|qr_code|\bqr\b/,             type: 'qrCode',     kind: 'QR code'              },
    { test: /datasource|data.?source|data_source|\bdata-\d/, type: 'dataSource', kind: 'data grid'           },
    { test: /\blogo\b/,                                    type: 'logo',       kind: 'logo'                 },
  ];

  let resolvedType = konvaNode.className.toLowerCase();
  let resolvedKind = kind;
  let useTextAsLabel = (resolvedType === 'text' || resolvedType === 'label'); // only plain text

  for (const pattern of WIDGET_PATTERNS) {
    if (pattern.test.test(directName)) {
      resolvedType = pattern.type;
      resolvedKind = pattern.kind;
      useTextAsLabel = false; // widget — don't expose dynamic/template text
      break;
    }
  }

  // Check ancestor names to add "in the data source" context when the clicked
  // element (text, image, etc.) lives inside a data source cell.
  const ancestorNames = konvaNode.ancestorNames || [];
  // Poppulo uses "data-1" (node name) AND "data-source"/"data-source-cells" (group names)
  // in the ancestor chain — match all forms.
  const DATA_ANCESTOR = /datasource|data.?source|data_source|\bdata-\d/;
  const isInDataSource = resolvedType !== 'dataSource' &&
    ancestorNames.some(n => DATA_ANCESTOR.test(n));
  if (isInDataSource) {
    resolvedKind = resolvedKind + ' in the data grid';
  }

  // Label: text content only for plain text elements, otherwise use the kind string
  const label = useTextAsLabel
    ? ((konvaNode.text || '').trim() || resolvedKind)
    : resolvedKind;

  meta.canvasElement = {
    type:  resolvedType,
    label,
    kind:  resolvedKind
  };
}

// ── Recording state ───────────────────────────────────────────────────────────
// recording and stepSeq declared at top of file — see "Top-level state" section

ipcRenderer.on('flo:start-recording', () => {
  recording = true;
});

ipcRenderer.on('flo:stop-recording', () => {
  recording = false;
});

// ── Click capture ─────────────────────────────────────────────────────────────
// Capture phase so we see the click before the page's handlers can call stopPropagation.
// NOTE: preload re-runs fresh on every navigation — recording resets to false each time.
// The host (app.js) re-sends flo:start-recording on the webview's dom-ready event to
// re-arm recording for the new page.

document.addEventListener('click', async (event) => {
  console.log('[flo] click — recording:', recording, 'tag:', (event.target || {}).tagName);
  if (!recording) return;
  const el = event.target;
  if (!el) return;

  // Clicks landing directly on <body> or <html> are dismiss/defocus actions
  // with no meaningful target — skip them entirely.
  const rawTag = (el.tagName || '').toLowerCase();
  if (rawTag === 'body' || rawTag === 'html') return;

  const stepId = ++stepSeq;
  const meta   = elementMetadata(el, event.clientX, event.clientY);
  meta.stepId  = stepId;

  // ── Profile-specific metadata enrichment ──────────────────────────────────

  // Always include the detected page profile so stepDescriber can tailor descriptions.
  meta.profile = pageProfile;

  // Canvas / design tool: attach the currently active drawing tool (if any),
  // and hit-test against the design API layout to identify the clicked element.
  if (pageProfile === 'canvasTool' && meta.tag === 'canvas') {
    meta.activeTool = findActiveTool();
    // Compute design-space coordinates from the top-level canvas click
    const canvasEl = event.target;
    const cr = canvasEl.getBoundingClientRect ? canvasEl.getBoundingClientRect() : null;
    if (cr && cr.width > 0) {
      // Store canvas-relative click position in CSS pixels.
      // enrichCanvasMeta will apply the Konva stage transform to convert to design coords.
      meta.designCoords = {
        x: event.clientX - cr.left,
        y: event.clientY - cr.top
      };
    }
    await enrichCanvasMeta(meta);
  }

  // Rich text / document editor: flag contenteditable targets so the describer
  // can say "Type in the editor" rather than "Click on the div".
  if (el.isContentEditable) {
    meta.isContentEditable = true;
  }

  // Dashboard / chart: mark chart canvases / SVG containers for better descriptions
  if ((pageProfile === 'dashboard' || pageProfile === 'canvasTool') && meta.tag === 'canvas') {
    meta.isChart = pageProfile === 'dashboard';
  }

  console.log('[flo] sendToHost flo:click — tag:', meta.tag, 'label:', meta.label, 'canvas?', !!meta.canvasElement);
  ipcRenderer.sendToHost('flo:click', meta);

  // Text fields AND contenteditable: initial click screenshots an empty box.
  // Re-capture on focusout so the guide shows the actual typed/filled value.
  if (isTextEntryElement(el) || el.isContentEditable) {
    el.addEventListener('focusout', () => {
      if (!recording) return;
      const updatedMeta = elementMetadata(el, event.clientX, event.clientY);
      updatedMeta.stepId = stepId;
      if (el.isContentEditable) updatedMeta.isContentEditable = true;
      ipcRenderer.sendToHost('flo:recapture', updatedMeta);
    }, { once: true });
  }
}, true);
