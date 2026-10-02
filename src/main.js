// Main process: window creation, IPC handlers, webview security enforcement.

const { app, BrowserWindow, ipcMain, dialog, shell, webContents, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const storage = require('./storage');
const { renderGuideHtml } = require('./exportHtml');
const confluenceExport = require('./confluenceExport');

// ── Transient Electron frame errors ───────────────────────────────────────────
// When the webview navigates, Electron disposes the old render frame. If we
// call wc.send() at exactly that moment the error is thrown from inside
// Electron's browser_init code — outside any try/catch we control.
//
// Electron registers its OWN uncaughtException listener (which shows the error
// dialog) before main.js runs. We remove it first and install our own so we can
// suppress the harmless frame-disposal race without showing the dialog.
// For every other uncaught exception we replicate Electron's default dialog.
process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (err) => {
  const msg = (err && err.message) ? err.message : String(err);
  if (msg.includes('disposed') || msg.includes('WebFrameMain')) {
    // Harmless race: the webview navigated while we were mid-send.
    // Recording re-arms itself on the next dom-ready — nothing to do.
    console.warn('[flo] [suppressed] transient frame error during navigation:', msg);
    return;
  }
  // Real error — show Electron's standard error dialog and log the stack.
  console.error('[flo] uncaughtException:', err);
  const { dialog: _dlg } = require('electron');
  _dlg.showErrorBox(
    'A JavaScript error occurred in the main process',
    `Uncaught Exception:\n${msg}\n\n${err.stack || ''}`
  );
});

// ── Dev auto-reload ───────────────────────────────────────────────────────────
// Watches src/ for file changes and reloads the renderer automatically.
// Only active during development (npm start); stripped from packaged installers.
if (!app.isPackaged) {
  try {
    require('electron-reload')(__dirname, {
      electron: require('electron'),
      hardResetMethod: 'exit'   // restarts main process when main.js itself changes
    });
  } catch { /* electron-reload not installed yet — run npm install */ }
}

function sanitizeFileName(name) {
  return (String(name || '')).replace(/[\\/:*?"<>|]/g, '_').trim() || 'guide';
}

// ── Window creation ────────────────────────────────────────────────────────────

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // preload world is isolated from page JS
      nodeIntegration: false,  // page JS cannot use Node APIs
      sandbox: false,          // preload CAN use require() for local modules
      webviewTag: true         // required for the <webview> element in index.html
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open DevTools automatically in dev mode so console errors are immediately visible.
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// ── Poppulo design API integration ────────────────────────────────────────────
// We passively intercept outgoing requests from the webview to capture:
//   - The auth token (Authorization header)
//   - The API base URL, company ID, and design ID (from URL patterns)
// This lets us call the /download endpoint later to get element layout for
// canvas click hit-testing — without ever prompting the user for credentials.

const designApiState = {
  authToken: null,
  companyId: null,
  designId:  null,
  apiBase:   null   // e.g. https://api-cloudtest1.fwi-dev.com
};

app.whenReady().then(() => {
  // Intercept all outgoing webview requests before they are sent.
  // Filter to those matching the Poppulo designer API URL shape.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || '';
    if (url.includes('/designer/v1/companies/') && url.includes('/designs/')) {
      // Capture API base URL (scheme + host)
      try {
        const u = new URL(url);
        designApiState.apiBase = u.origin;
      } catch {}

      // Capture Authorization header (Bearer token or similar)
      const auth = details.requestHeaders['Authorization'] ||
                   details.requestHeaders['authorization'];
      if (auth) designApiState.authToken = auth;

      // Parse company ID and design ID from the URL path
      const m = url.match(/\/companies\/([^/?#]+)\/designs\/([^/?#]+)/);
      if (m) {
        designApiState.companyId = m[1];
        designApiState.designId  = m[2];
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Webview security ──────────────────────────────────────────────────────────
// Force our preload into every webview, overriding anything the renderer HTML requested.
// This gives the recorded page's preload script DOM access without ever exposing
// Node/filesystem access to the page itself.

app.on('web-contents-created', (event, wc) => {
  wc.on('will-attach-webview', (e, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'preload-webview.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false; // preload needs require('electron') — can't be sandboxed
  });

  // Deny window.open() / target=_blank popups from inside the recorded site,
  // so a stray click can't spawn an unmanaged window outside the capture flow.
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('capture:screenshot', async (event, webContentsId) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return null;
    const image = await wc.capturePage();
    // Normalize to 1920px wide regardless of device pixel ratio.
    // Height scales proportionally so the aspect ratio is preserved.
    const normalized = image.resize({ width: 1920 });
    return normalized.toDataURL();
  } catch {
    return null;
  }
});

// Relay a message from the renderer to a webview's preload.
// webview.send() is async in Electron 28+ and can silently reject;
// routing through main guarantees delivery via webContents.send().
ipcMain.handle('webview:relay', async (event, { wcId, channel, args }) => {
  try {
    const wc = webContents.fromId(wcId);
    // isDestroyed() guards against the "frame disposed" race: when the webview
    // navigates to a new page, the old WebContents may still exist in the
    // fromId registry for a brief moment but the underlying frame is gone.
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, ...(args || []));
  } catch (err) {
    // Log only genuinely unexpected errors; frame-disposal errors during
    // navigation are already suppressed by the uncaughtException handler above.
    if (!err.message.includes('disposed') && !err.message.includes('WebFrameMain')) {
      console.error('[flo] webview:relay error:', err.message);
    }
  }
});

// Returns the currently captured design API context (may be null until the
// recorded page makes its first API call or the preload extracts IDs from the URL).
ipcMain.handle('design:context', () => ({ ...designApiState }));

// Allows the preload to push company/design IDs it found in the page URL.
ipcMain.handle('design:setIds', (_event, { companyId, designId }) => {
  if (companyId) designApiState.companyId = companyId;
  if (designId)  designApiState.designId  = designId;
});

// Fetches the full design node layout from Poppulo's /download endpoint.
// Runs in the main process so there are no CORS restrictions.
// Uses the default session's cookie jar (same as the webview) so no explicit
// auth header is needed if Poppulo uses cookie-based authentication.
ipcMain.handle('design:fetch', async () => {
  const { authToken, companyId, designId, apiBase } = designApiState;
  if (!companyId || !designId) {
    console.log('[flo] design:fetch — missing companyId or designId, state:', designApiState);
    return null;
  }

  const base = apiBase || 'https://api-cloudtest1.fwi-dev.com';
  const url  = `${base}/designer/v1/companies/${companyId}/designs/${designId}/download`;
  console.log('[flo] design:fetch →', url);

  return new Promise((resolve) => {
    // useSessionCookies: true shares the webview's login session (cookie-based auth)
    const req = net.request({ method: 'GET', url, useSessionCookies: true });
    if (authToken) req.setHeader('Authorization', authToken);
    req.setHeader('Accept', 'application/json');

    let body = '';
    req.on('response', (res) => {
      console.log('[flo] design:fetch status:', res.statusCode);
      res.on('data',  chunk => { body += chunk; });
      res.on('end',   ()    => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      res.on('error', ()    => resolve(null));
    });
    req.on('error', (err) => { console.warn('[flo] design:fetch net error:', err.message); resolve(null); });
    req.end();
  });
});

ipcMain.handle('guides:list',           async ()           => storage.listGuides());
ipcMain.handle('guides:load',           async (_, id)      => storage.loadGuide(id));
ipcMain.handle('guides:save',           async (_, guide)   => storage.saveGuide(guide));
ipcMain.handle('guides:delete',         async (_, id)      => storage.deleteGuide(id));
ipcMain.handle('guides:listVersions',   async (_, id)      => storage.listGuideVersions(id));
ipcMain.handle('guides:loadVersion',    async (_, id, ver) => storage.loadGuideVersion(id, ver));

ipcMain.handle('export:pdf', async (event, guideId) => {
  const guide = storage.loadGuide(guideId);
  if (!guide) return { ok: false, reason: 'guide_not_found' };

  const { filePath, canceled } = await dialog.showSaveDialog({
    defaultPath: sanitizeFileName(guide.title) + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });

  if (canceled || !filePath) return { ok: false, reason: 'cancelled' };

  const html = renderGuideHtml(guide);

  // Write to a temp file so large base64 screenshots don't hit data-URL length limits
  const tmpFile = path.join(os.tmpdir(), `flo-print-${Date.now()}.html`);
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });

  try {
    fs.writeFileSync(tmpFile, html, 'utf8');
    await pdfWin.loadURL(`file:///${tmpFile.replace(/\\/g, '/')}`);
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: 'Letter',
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#a097b5;font-family:Segoe UI,Arial,sans-serif;padding-bottom:4px"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margins: { marginType: 'custom', top: 0.6, bottom: 0.75, left: 0.6, right: 0.6 }
    });
    fs.writeFileSync(filePath, pdfBuffer);
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    pdfWin.close();
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
});

ipcMain.handle('export:word', async (event, guideId) => {
  const guide = storage.loadGuide(guideId);
  if (!guide) return { ok: false, reason: 'guide_not_found' };

  const { filePath, canceled } = await dialog.showSaveDialog({
    defaultPath: sanitizeFileName(guide.title) + '.doc',
    filters: [{ name: 'Word Document', extensions: ['doc'] }]
  });

  if (canceled || !filePath) return { ok: false, reason: 'cancelled' };

  // Generate a Word-compatible HTML document.
  // Word 2007+ opens HTML files with the xmlns Office namespaces directly,
  // preserving all formatting (bold/italic/lists/images as base64).
  const html = renderGuideHtml(guide, { wordCompat: true });
  try {
    fs.writeFileSync(filePath, html, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('export:confluence', async (event, payload) => {
  const guide = storage.loadGuide(payload.guideId);
  if (!guide) return { ok: false, reason: 'guide_not_found' };
  try {
    const result = await confluenceExport.exportGuide(guide, payload);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, reason: 'request_failed', message: err.message };
  }
});
