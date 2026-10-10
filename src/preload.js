// contextBridge API exposed to all renderer code as window.flo.
// This is the entire surface the renderer is allowed to call.

const { contextBridge, ipcRenderer } = require('electron');
const { describeStep } = require('./stepDescriber');

contextBridge.exposeInMainWorld('flo', {
  // Synchronous — calls stepDescriber directly, no IPC round-trip needed
  describeStep(meta) {
    return describeStep(meta);
  },

  captureScreenshot(webContentsId) {
    return ipcRenderer.invoke('capture:screenshot', webContentsId);
  },

  listGuides() {
    return ipcRenderer.invoke('guides:list');
  },

  loadGuide(id) {
    return ipcRenderer.invoke('guides:load', id);
  },

  saveGuide(guide) {
    return ipcRenderer.invoke('guides:save', guide);
  },

  deleteGuide(id) {
    return ipcRenderer.invoke('guides:delete', id);
  },

  exportPdf(guideId) {
    return ipcRenderer.invoke('export:pdf', guideId);
  },

  exportConfluence(payload) {
    return ipcRenderer.invoke('export:confluence', payload);
  },

  exportWord(guideId) {
    return ipcRenderer.invoke('export:word', guideId);
  },

  listGuideVersions(id) {
    return ipcRenderer.invoke('guides:listVersions', id);
  },

  loadGuideVersion(id, version) {
    return ipcRenderer.invoke('guides:loadVersion', id, version);
  },

  // Route a message from the renderer to a specific webview preload via the main process.
  // More reliable than webview.send() which is async in Electron 28+ and can reject silently.
  sendToWebview(wcId, channel, ...args) {
    return ipcRenderer.invoke('webview:relay', { wcId, channel, args });
  },

  // ── Desktop capture APIs ───────────────────────────────────────────────────

  getDesktopSources(sourceType) {
    return ipcRenderer.invoke('desktop:getSources', sourceType || 'window');
  },

  captureDesktopSource(sourceId) {
    return ipcRenderer.invoke('desktop:captureSource', sourceId);
  },

  startDesktopHook() {
    return ipcRenderer.invoke('desktop:startHook');
  },

  stopDesktopHook() {
    return ipcRenderer.invoke('desktop:stopHook');
  },

  onDesktopClick(cb) {
    ipcRenderer.on('desktop:click', (_event, data) => cb(data));
  },

  offDesktopClick() {
    ipcRenderer.removeAllListeners('desktop:click');
  }
});
