// Confluence REST API export. Self-contained — never touches the capture engine or Editor.
// Supports both Confluence Cloud (Basic auth: email + API token) and
// Server/Data Center (Bearer auth: Personal Access Token).
// The presence/absence of an email is the signal for which is being used.

function authHeader({ email, token }) {
  if (email && email.trim()) {
    return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  }
  return `Bearer ${token}`;
}

function dataUrlToBuffer(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid data URL format');
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderInline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

// Renders markdown text to Confluence Storage Format, including lists.
function renderMarkdownToConfluence(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*- /.test(line)) {
      let html = '<ul>';
      while (i < lines.length && /^\s*- /.test(lines[i])) {
        const m = lines[i].match(/^(\s*)- (.*)/);
        html += '<li>' + renderInline(escapeXml(m[2])) + '</li>';
        i++;
      }
      parts.push(html + '</ul>');
      continue;
    }
    if (/^\s*\d+\. /.test(line) || /^\s+[a-z]\. /.test(line)) {
      let html = '<ol>';
      while (i < lines.length && (/^\s*\d+\. /.test(lines[i]) || /^\s+[a-z]\. /.test(lines[i]))) {
        const m = lines[i].match(/^(\s*)(?:\d+|[a-z])\. (.*)/);
        html += '<li>' + renderInline(escapeXml(m[2])) + '</li>';
        i++;
      }
      parts.push(html + '</ol>');
      continue;
    }
    parts.push(renderInline(escapeXml(line)));
    i++;
  }
  return parts.reduce((acc, part, j) => {
    if (j === 0) return part;
    const isBlock = (s) => s.startsWith('<ul') || s.startsWith('<ol');
    return acc + (isBlock(parts[j - 1]) || isBlock(part) ? '' : '<br/>') + part;
  }, '');
}

function buildStorageBody(guide, attachmentFilenames) {
  const steps = guide.steps || [];
  return steps.map((step, i) => {
    const filename = attachmentFilenames[i];
    const imgMacro = filename
      ? `<ac:image><ri:attachment ri:filename="${escapeXml(filename)}"/></ac:image>`
      : '';
    return `<h2>Step ${i + 1}</h2>${imgMacro}<p>${renderMarkdownToConfluence(step.text || '')}</p>`;
  }).join('');
}

async function exportGuide(guide, { baseUrl, spaceKey, email, token, pageTitle }) {
  const base = baseUrl.replace(/\/+$/, '');
  const auth = authHeader({ email, token });
  const jsonHeaders = {
    'Authorization': auth,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // Step 1: Create page with placeholder body (attachments need a content id first)
  const createRes = await fetch(`${base}/wiki/rest/api/content`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      type: 'page',
      title: pageTitle || guide.title || 'Untitled Guide',
      space: { key: spaceKey },
      body: {
        storage: { value: '<p>Generating guide...</p>', representation: 'storage' }
      }
    })
  });

  if (!createRes.ok) {
    const errText = (await createRes.text()).slice(0, 300);
    throw new Error(`Failed to create page (${createRes.status}): ${errText}`);
  }

  const createData = await createRes.json();
  const pageId = createData.id;
  const pageVersion = createData.version.number;

  // Step 2: Upload each step's screenshot as an attachment
  const steps = guide.steps || [];
  const attachmentFilenames = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.screenshotDataUrl) {
      attachmentFilenames.push(null);
      continue;
    }

    const filename = `step-${i + 1}.png`;
    let buffer, mime;
    try {
      ({ buffer, mime } = dataUrlToBuffer(step.screenshotDataUrl));
    } catch {
      attachmentFilenames.push(null);
      continue;
    }

    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: mime }), filename);
    formData.append('comment', `Step ${i + 1} screenshot`);

    const attachRes = await fetch(
      `${base}/wiki/rest/api/content/${pageId}/child/attachment`,
      {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'X-Atlassian-Token': 'no-check' // required to bypass XSRF checking
        },
        body: formData
      }
    );

    attachmentFilenames.push(attachRes.ok ? filename : null);
  }

  // Step 3: Rebuild page with real body now that attachment filenames are known.
  // Version MUST be exactly previous + 1, or Confluence rejects the update.
  const realBody = buildStorageBody(guide, attachmentFilenames);
  const updateRes = await fetch(`${base}/wiki/rest/api/content/${pageId}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({
      version: { number: pageVersion + 1 },
      title: pageTitle || guide.title || 'Untitled Guide',
      type: 'page',
      body: { storage: { value: realBody, representation: 'storage' } }
    })
  });

  if (!updateRes.ok) {
    const errText = (await updateRes.text()).slice(0, 300);
    throw new Error(`Failed to update page body (${updateRes.status}): ${errText}`);
  }

  const updateData = await updateRes.json();
  const webui = updateData._links && updateData._links.webui;
  const pageUrl = webui
    ? `${base}${webui}`
    : `${base}/wiki/pages/viewpage.action?pageId=${pageId}`;

  return { pageId, pageUrl };
}

module.exports = { exportGuide };
