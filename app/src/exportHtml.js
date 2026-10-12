// Renders a guide to a standalone print-friendly HTML string for PDF export.
// Runs in the main process — uses regex-based HTML escaping (no DOM available here).

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

// Build a depth-indented list block from consecutive list lines.
// Each sub-level is rendered as a genuinely nested <ul>/<ol> so the PDF
// renderer sees proper HTML nesting and indents correctly.
function buildListHtml(lines, startIdx, ulTag) {
  // Collect all consecutive list lines
  const isListLine = ulTag === 'ul'
    ? (l) => /^\s*- /.test(l)
    : (l) => /^\s*\d+\. /.test(l) || /^\s+[a-z]\. /.test(l);

  const items = [];
  let i = startIdx;
  while (i < lines.length && isListLine(lines[i])) {
    const m = ulTag === 'ul'
      ? lines[i].match(/^(\s*)- (.*)/)
      : lines[i].match(/^(\s*)(?:\d+|[a-z])\. (.*)/);
    const depth = m ? Math.floor(m[1].length / 2) : 0;
    const content = m ? renderInline(escapeHtml(m[m.length - 1])) : '';
    items.push({ depth, content });
    i++;
  }

  // Build proper nested list HTML from the flat depth-annotated items
  function buildNested(items, curDepth) {
    let html = '';
    let j = 0;
    while (j < items.length) {
      const item = items[j];
      if (item.depth < curDepth) break;
      if (item.depth > curDepth) {
        // Collect deeper items and recurse
        const sub = [];
        while (j < items.length && items[j].depth > curDepth) { sub.push(items[j]); j++; }
        html += buildNested(sub, curDepth + 1);
        continue;
      }
      html += `<li>${item.content}`;
      // Look ahead for deeper children
      j++;
      const children = [];
      while (j < items.length && items[j].depth > curDepth) { children.push(items[j]); j++; }
      if (children.length) html += buildNested(children, curDepth + 1);
      html += '</li>';
    }
    // Determine list type for this level
    const tag = (ulTag === 'ol' && curDepth === 0) ? 'ol' : (curDepth > 0 ? (ulTag === 'ol' ? 'ol' : 'ul') : 'ul');
    const typeAttr = ulTag === 'ol'
      ? [' type="1"', ' type="a"', ' type="i"'][Math.min(curDepth, 2)]
      : '';
    return `<${tag}${typeAttr}>${html}</${tag}>`;
  }

  return { html: buildNested(items, 0), endIdx: i };
}

// Full markdown renderer for PDF: handles lists + inline formatting.
function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*- /.test(line)) {
      const { html, endIdx } = buildListHtml(lines, i, 'ul');
      parts.push(html);
      i = endIdx;
      continue;
    }
    if (/^\s*\d+\. /.test(line) || /^\s+[a-z]\. /.test(line)) {
      const { html, endIdx } = buildListHtml(lines, i, 'ol');
      parts.push(html);
      i = endIdx;
      continue;
    }
    parts.push(renderInline(escapeHtml(line)));
    i++;
  }
  return parts.reduce((acc, part, j) => {
    if (j === 0) return part;
    const isBlock = (s) => s.startsWith('<ul') || s.startsWith('<ol');
    return acc + (isBlock(parts[j - 1]) || isBlock(part) ? '' : '<br>') + part;
  }, '');
}


function renderGuideHtml(guide, { wordCompat = false } = {}) {
  const title = escapeHtml(guide.title || 'Untitled guide');
  const steps = guide.steps || [];

  // A step is "long" if it would overflow a half-page slot when paired.
  // Threshold: 8+ numbered sub-steps, or >450 total chars (long descriptions wrap visually).
  function isLongStep(step) {
    const lines = (step.text || '').split('\n').filter(l => l.trim());
    return lines.length > 7 || (step.text || '').length > 450;
  }

  // Smart grouping: short steps pair (2 per page); long steps get their own page.
  const pageGroups = [];
  let gi = 0;
  while (gi < steps.length) {
    if (isLongStep(steps[gi])) {
      pageGroups.push([steps[gi]]);
      gi++;
    } else {
      const next = steps[gi + 1];
      if (next && !isLongStep(next)) {
        pageGroups.push([steps[gi], next]);
        gi += 2;
      } else {
        pageGroups.push([steps[gi]]);
        gi++;
      }
    }
  }
  const totalPages = pageGroups.length;

  // Precompute per-step display numbers (groups can now have 1 or 2 steps).
  let stepCounter = 0;
  const numberedGroups = pageGroups.map(group =>
    group.map(step => ({ step, num: ++stepCounter }))
  );

  // Render one step row (shared between PDF and Word).
  // Uses <div> not <section> — Word's HTML renderer ignores HTML5 semantic elements.
  function renderStep(step, stepNum) {
    const hasImg = !!step.screenshotDataUrl;
    const textMd = renderMarkdown(step.text || '');

    let imgTag = '';
    if (hasImg) {
      if (wordCompat) {
        // Screenshots are always 1920×1080. width="400" (≈4.17in at 96dpi) scales
        // to 400×225px — Word auto-scales height from the width attribute alone,
        // preserving aspect ratio. Two steps at ~2.3in tall fit a landscape page.
        imgTag = `<img src="${step.screenshotDataUrl}" width="300" alt="Step ${stepNum}" />`;
      } else {
        imgTag = `<img src="${step.screenshotDataUrl}" alt="Step ${stepNum}" />`;
      }
    }

    const rowInner = hasImg
      ? `<td class="step-img-cell">${imgTag}</td>
         <td class="step-txt-cell"><div class="step-text">${textMd}</div></td>`
      : `<td colspan="2" class="step-txt-cell"><div class="step-text">${textMd}</div></td>`;
    return `
    <div class="step">
      <div class="step-num">Step ${stepNum}</div>
      <table class="step-row"><tr>${rowInner}</tr></table>
    </div>`;
  }

  let pagesHtml;

  if (wordCompat) {
    // Word needs page breaks as <p> elements with page-break-before + mso-break-type.
    // page-break-after on <div> is unreliable in Word's HTML renderer.
    // Footer is a plain <p> inserted before each break so Word places it correctly.
    const parts = [];
    numberedGroups.forEach((group, groupIdx) => {
      const isLast = groupIdx === numberedGroups.length - 1;
      group.forEach(({ step, num }) => parts.push(renderStep(step, num)));
      if (!isLast) {
        // <o:p> with page-break-before is the Office-native page break for Word HTML.
        parts.push(`<p style="page-break-before:always;margin:0pt"><o:p>&nbsp;</o:p></p>`);
      }
    });
    pagesHtml = parts.join('\n');
  } else {
    // PDF (Chromium): page-break-after:always on a wrapper div works reliably.
    // Footer is rendered via @page { @bottom-center } — no HTML element needed.
    pagesHtml = numberedGroups.map((group, groupIdx) => {
      const isLast = groupIdx === numberedGroups.length - 1;
      const groupSteps = group.map(({ step, num }) => renderStep(step, num)).join('\n');
      const breakStyle = isLast ? '' : ' style="page-break-after:always"';
      return `<div class="page-group"${breakStyle}>${groupSteps}</div>`;
    }).join('\n');
  }

  // Word-compatible HTML adds Office namespace declarations so Word opens the
  // file cleanly without "file is in a different format" warnings.
  const htmlAttrs = wordCompat
    ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"'
    : '';
  const wordMeta = wordCompat
    ? '\n<meta name="ProgId" content="Word.Document">'
    : '';

  // Word ignores standard @page {size:landscape} — it requires a named section
  // (@page WordSection1 with mso-page-orientation) and a wrapping div.
  // PDF (Chromium) uses the plain @page rule instead.
  const landscapeCss = wordCompat
    ? `@page WordSection1 { size: 11.0in 8.5in; margin: 0.5in 0.5in 0.75in 0.5in; mso-page-orientation: landscape; mso-footer-margin: 0.35in; mso-footer: f1; }
  div.WordSection1 { page: WordSection1; }`
    : `@page { size: landscape; margin: 0.6in; }`;

  // Word-specific spacing overrides — Word adds extra inter-block spacing vs Chromium.
  const wordImageCss = wordCompat
    ? `.step { margin-bottom: 6px !important; padding-bottom: 6px !important; }
  .step-num { margin-bottom: 3px !important; }
  .subtitle { margin-bottom: 10px !important; }`
    : '';

  const bodyOpen  = wordCompat ? '<body>\n<div class="WordSection1">' : '<body>';
  // Word footer div — uses mso-element:field-begin/end field codes so Word renders
  // PAGE and NUMPAGES as live fields (dynamic page numbers) in the footer area.
  // Wrapped in IE/MSO conditional comment so Word processes it as a true footer
  // while Chromium (and all modern browsers) ignore the block entirely — no content leak.
  const wordFooter = wordCompat ? `<!--[if gte mso 9]>
<div style="mso-element:footer" id="f1">
<p style="text-align:center;font-family:'Segoe UI',Arial,sans-serif;font-size:9pt;color:#a097b5;margin:0pt">
<span style="mso-element:field-begin"></span>PAGE<span style="mso-element:field-separator"></span>1<span style="mso-element:field-end"></span>
&nbsp;/&nbsp;
<span style="mso-element:field-begin"></span>NUMPAGES<span style="mso-element:field-separator"></span>1<span style="mso-element:field-end"></span>
</p>
</div>
<![endif]-->` : '';
  const bodyClose = wordCompat ? `</div>\n${wordFooter}\n</body>` : '</body>';

  return `<!DOCTYPE html>
<html lang="en"${htmlAttrs}>
<head>
<meta charset="UTF-8">${wordMeta}
<title>${title}</title>
<style>
  ${landscapeCss}
  /* Explicit sans-serif stack avoids any chance of a system serif being picked up
     by the Electron PDF renderer. "Segoe UI" is first so Windows renders it crisply. */
  body {
    font-family: "Segoe UI", "Helvetica Neue", Arial, Helvetica, sans-serif;
    max-width: 1100px;
    margin: 0 auto;
    padding: 20px 28px;
    color: #211f29;
    font-size: 13px;
    line-height: 1.5;
  }
  h1 { font-family: Georgia, "Times New Roman", serif; font-size: 1.8em; margin: 0 0 4px; }
  .subtitle { color: #756f81; margin: 0 0 16px; font-size: 0.88em; }
  /* page-group wraps each pair of steps; page-break-after:always is set inline above */
  .page-group { display: block; }
  /* No page-break-inside:avoid on .step — page groups own the pagination.
     That property caused Word to float steps to unexpected positions. */
  .step { margin-bottom: 10px; padding-bottom: 10px; }
  .step:last-of-type { margin-bottom: 6px; padding-bottom: 0; }
  .step-num {
    font-family: "Segoe UI", "Helvetica Neue", Arial, Helvetica, sans-serif;
    font-size: 0.75em;
    font-weight: 700;
    color: #6a5b95;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 5px;
  }
  /* Table gives reliable two-column layout in both PDF and Word's HTML renderer */
  .step-row { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .step-img-cell { width: 57%; padding-right: 14px; vertical-align: top; }
  .step-img-cell img {
    max-width: 100%;
    max-height: 2.3in;
    border: 1px solid #ddd9e6;
    border-radius: 6px;
    display: block;
    object-fit: contain;
  }
  .step-txt-cell { vertical-align: top; padding-top: 2px; }
  /* white-space: pre-line so multi-action grouped step text (\\n-joined) renders as
     separate lines rather than being collapsed by default HTML whitespace handling. */
  .step-text {
    font-family: "Segoe UI", "Helvetica Neue", Arial, Helvetica, sans-serif;
    white-space: pre-line;
    margin: 0;
  }
  .step strong { font-weight: 600; }
  .step em { font-style: italic; }
  .step code {
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 0.88em;
    background: #f0ecf8;
    color: #5a4a8a;
    padding: 1px 5px;
    border-radius: 4px;
  }
  /* Lists: generous padding-left so bullet/number markers are never clipped.
     white-space:normal overrides the pre-line from .step-text for list content. */
  .step-text ul, .step-text ol {
    margin: 4px 0;
    padding-left: 2em;
    white-space: normal;
    font-family: "Segoe UI", "Helvetica Neue", Arial, Helvetica, sans-serif;
  }
  .step-text li { margin: 2px 0; }
  .page-footer {
    text-align: center;
    font-family: "Segoe UI", "Helvetica Neue", Arial, Helvetica, sans-serif;
    font-size: 0.78em;
    color: #a097b5;
    margin-top: 8px;
  }
  /* Word-only: <p> with these styles is the most reliable page break in Word's HTML renderer */
  .word-page-break {
    page-break-before: always;
    mso-break-type: page-break;
    margin: 0;
    font-size: 1px;
    line-height: 0;
  }
  ${wordImageCss}
</style>
</head>
${bodyOpen}
<h1>${title}</h1>
<p class="subtitle">Generated by Flo, the Chronicler</p>
<!-- TODO: prepend "By <username> —" once user display name is wired up from Settings -->
${pagesHtml}
${bodyClose}
</html>`;
}

module.exports = { renderGuideHtml };
