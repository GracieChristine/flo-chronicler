// Template-based step description generation. No AI/LLM — v1 works with zero API key.
// Dual-mode export: works via require() or as a plain <script> tag.

const INPUT_TYPE_PHRASES = {
  email: 'an email address',
  password: 'a password',
  tel: 'a phone number',
  number: 'a number',
  url: 'a URL',
  search: 'a search term',
  date: 'a date'
};

function describeStep(meta) {
  const tag = (meta.tag || '').toLowerCase();
  const type = (meta.type || '').toLowerCase();
  const role = (meta.role || '').toLowerCase();
  const label = meta.label || 'element';

  // ── Explicit tag matches ─────────────────────────────────────────────────

  if (tag === 'a') {
    return meta.looksLikeButton
      ? `Click the "${label}" button.`
      : `Click the "${label}" link.`;
  }

  if (tag === 'button') {
    if (meta.profile === 'canvasTool') {
      // In design tools, distinguish action buttons (Save, Next, Cancel…) from
      // tool/content-type selectors (Text, Rectangle, Image…).
      // Action buttons keep "Click"; tool selectors become "Select … tool."
      // We check aria-pressed first (explicit signal), then fall back to a word list.
      if (meta.ariaPressed !== null && meta.ariaPressed !== undefined) {
        return `Select the "${label}" tool.`;
      }
      const ACTION_WORDS = [
        'save','open','close','cancel','next','back','previous','prev',
        'done','submit','export','import','connect','upload','download',
        'delete','remove','create','edit','update','confirm','ok','yes','no',
        'apply','reset','refresh','continue','finish','complete','skip',
        'undo','redo','copy','paste','cut','share','send','publish','preview','clear',
        'login','logout','sign in','sign out','search','filter','sort',
        'add','new','duplicate','rename','move','select all','deselect'
      ];
      const lowerLabel = label.toLowerCase();
      const isAction = ACTION_WORDS.some(w =>
        lowerLabel === w || lowerLabel.startsWith(w + ' ') || lowerLabel.endsWith(' ' + w)
      );
      if (!isAction) {
        // Buttons that open workspace panels are "tools"; everything else adds
        // content to the canvas and is an "element".
        const PANEL_TOOLS = ['widgets', 'layers', 'layer', 'library panel', 'effective local time'];
        const isTool = PANEL_TOOLS.includes(lowerLabel.trim());

        // Some sidebar labels are more verbose than needed — map to a cleaner display name.
        const LABEL_MAP = { 'data source': 'Data' };
        const displayLabel = LABEL_MAP[lowerLabel.trim()] || label;

        // Short all-caps labels (AM, PM, …) are value toggles, not element adders —
        // use the same bare "Select" format as <li> option items.
        const isValueToggle = /^[A-Z]{1,4}$/.test(label);

        return isTool       ? `Select the "${displayLabel}" tool.`
             : isValueToggle ? `Select "${displayLabel}".`
             :                 `Select the "${displayLabel}" element.`;
      }
    }
    return `Click the "${label}" button.`;
  }

  if (tag === 'input') {
    if (type === 'checkbox') return `Check the "${label}" checkbox.`;
    if (type === 'radio')    return `Select the "${label}" option.`;
    if (type === 'submit' || type === 'button') return `Click the "${label}" button.`;
    const phrase = INPUT_TYPE_PHRASES[type] || 'text';
    return `Enter ${phrase} in the "${label}" field.`;
  }

  if (tag === 'textarea') {
    return `Enter text in the "${label}" field.`;
  }

  if (tag === 'select') {
    return `Choose an option from the "${label}" dropdown.`;
  }

  // Native <option> (rare — effectiveTarget normally walks up to <select>,
  // but handle it explicitly just in case)
  if (tag === 'option') {
    return `Select "${label}".`;
  }

  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
    return `Click the "${label}" heading.`;
  }

  // ── Canvas interactions ──────────────────────────────────────────────────
  // Design tools, charts, and image editors draw into <canvas> — the content
  // isn't in the DOM, so we describe based on the profile context we detected.
  if (tag === 'canvas') {
    // ── Best case: hit-test matched a specific design element ────────────────
    // canvasElement is populated by fetching the Poppulo design API and doing a
    // coordinate hit-test against the element layout. Gives precise descriptions.
    if (meta.canvasElement) {
      const { label: elLabel, kind } = meta.canvasElement;
      // For plain text elements the label IS the text content — quote it.
      // Widget types (datetime, qrCode, dataSource, logo, etc.) use their kind as
      // the label and should not be quoted (they're type names, not user content).
      const isText = meta.canvasElement.type === 'text' || meta.canvasElement.type === 'label';
      // If kind already contains location context ("in the data grid") don't append "on the canvas"
      const location = kind.includes(' in the ') ? '' : ' on the canvas';
      return isText
        ? `Click the "${elLabel}" ${kind}${location}.`
        : `Click the ${elLabel}${location}.`;
    }

    // ── Second best: active tool context when placing a new element ──────────
    if (meta.activeTool) {
      const t = meta.activeTool.toLowerCase();
      if (t === 'text' || t === 'type' || t === 'text box')
        return 'Add a text element to the design.';
      if (t.includes('rect') || t === 'box' || t === 'square')
        return 'Draw a rectangle on the design.';
      if (t.includes('ellipse') || t.includes('circle') || t === 'oval')
        return 'Draw an ellipse on the design.';
      if (t.includes('line') || t === 'arrow')
        return `Draw a ${meta.activeTool.toLowerCase()} on the design.`;
      if (t.includes('image') || t.includes('photo') || t.includes('media') || t.includes('picture'))
        return 'Add a media element to the design.';
      if (t === 'select' || t === 'pointer' || t === 'move' || t === 'cursor')
        return 'Select or reposition an element on the design.';
      return `Place a "${meta.activeTool}" element on the design.`;
    }

    // ── Fallback: dashboard chart or generic ─────────────────────────────────
    if (meta.isChart) {
      return label && label !== 'canvas'
        ? `Interact with the "${label}" chart.`
        : 'Interact with the chart.';
    }
    return label && label !== 'canvas'
      ? `Click the "${label}" canvas.`
      : 'Click on the canvas.';
  }

  // ── Rich text / contenteditable ──────────────────────────────────────────
  if (meta.isContentEditable) {
    return label && label !== (tag || 'element')
      ? `Type in the "${label}" editor.`
      : 'Type in the editor.';
  }

  // ── Landmark elements (main, section, article, nav, etc.) ────────────────
  // If they carry an aria-label/title it's meaningful; otherwise use region name.
  if (['main', 'section', 'article'].includes(tag)) {
    return label && label !== tag ? `Click the "${label}" area.` : 'Click on the page.';
  }
  if (tag === 'nav')    return label && label !== 'nav'    ? `Click the "${label}" navigation.` : 'Click on the navigation.';
  if (tag === 'header') return label && label !== 'header' ? `Click the "${label}" header.`     : 'Click on the header.';
  if (tag === 'footer') return label && label !== 'footer' ? `Click the "${label}" footer.`     : 'Click on the footer.';
  if (tag === 'form')   return label && label !== 'form'   ? `Fill in the "${label}" form.`     : 'Fill in the form.';

  // ── ARIA role matches (custom components) ────────────────────────────────
  // These fire when the effective target is a <div> / <span> / <li> carrying
  // an explicit ARIA role — e.g. custom dropdowns, tab bars, menus.

  if (role === 'button' || role === 'link') {
    return `Click the "${label}" button.`;
  }

  if (role === 'option') {
    // Custom dropdown or listbox item
    return `Select "${label}".`;
  }

  if (role === 'tab') {
    return `Switch to the "${label}" tab.`;
  }

  if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    return `Click the "${label}" menu item.`;
  }

  if (role === 'checkbox') return `Check the "${label}" checkbox.`;
  if (role === 'radio')    return `Select the "${label}" option.`;
  if (role === 'switch')   return `Toggle the "${label}" switch.`;

  if (role === 'treeitem' || role === 'gridcell') {
    return `Click "${label}".`;
  }

  // ── Generic tag fallbacks ────────────────────────────────────────────────

  // List items are selections (font choices, dropdown items, menu entries)
  // not text to read — "Select" is almost always the right verb.
  if (tag === 'li') {
    return `Select "${label}".`;
  }

  if (['p', 'span'].includes(tag)) {
    return `Click the "${label}" text.`;
  }

  // Any element with a recognisable role but not matched above
  if (role) {
    return `Click the "${label}" ${role}.`;
  }

  if (tag) {
    return `Click the "${label}" ${tag}.`;
  }

  return `Click "${label}".`;
}

if (typeof module !== 'undefined') {
  module.exports = { describeStep };
} else {
  window.stepDescriber = { describeStep };
}
