/**
 * Generates assets/icon.png (512×512) and assets/icon.ico (multi-resolution)
 * from assets/logo.svg using Electron's offscreen rendering + nativeImage.
 *
 * Run with:  node_modules\electron\dist\electron.exe scripts/make-icon.js
 *
 * The ICO contains 16, 32, 48, 256 and 512 px sizes so the Windows taskbar,
 * title bar and Start menu stay crisp at any DPI level.
 */
// In Electron 31+, require('electron') from a script resolves to the npm
// package (which exports the path string).  The actual Electron main-process
// API lives at the 'electron/main' subpath which Electron intercepts before
// Node's module resolution can reach the npm package.
const { app, BrowserWindow, nativeImage } = require('electron/main');
const path = require('path');
const fs   = require('fs');

// ICO sizes Windows uses at various UI contexts
const ICO_SIZES = [16, 32, 48, 256, 512];

/**
 * Build a Windows .ico binary that embeds raw PNG images (PNG-in-ICO).
 * Supported since Windows Vista; produces crisp icons at every scale.
 */
function buildIco(pngBuffers, sizes) {
  const count          = pngBuffers.length;
  const HEADER_BYTES   = 6;
  const DIR_ENTRY_SIZE = 16;
  const dataOffset     = HEADER_BYTES + count * DIR_ENTRY_SIZE;

  const offsets = [];
  let off = dataOffset;
  for (const buf of pngBuffers) { offsets.push(off); off += buf.length; }

  const header = Buffer.alloc(dataOffset);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = 1 (icon)
  header.writeUInt16LE(count, 4);  // number of images

  for (let i = 0; i < count; i++) {
    const e = HEADER_BYTES + i * DIR_ENTRY_SIZE;
    const w = sizes[i] >= 256 ? 0 : sizes[i]; // 0 = 256 px in ICO directory
    const h = sizes[i] >= 256 ? 0 : sizes[i];
    header.writeUInt8(w, e + 0);
    header.writeUInt8(h, e + 1);
    header.writeUInt8(0, e + 2);   // color count
    header.writeUInt8(0, e + 3);   // reserved
    header.writeUInt16LE(1,  e + 4);                     // planes
    header.writeUInt16LE(32, e + 6);                     // bits per pixel
    header.writeUInt32LE(pngBuffers[i].length, e + 8);   // bytes in res
    header.writeUInt32LE(offsets[i], e + 12);            // offset of image
  }

  return Buffer.concat([header, ...pngBuffers]);
}

app.whenReady().then(async () => {
  try {
    const assetsDir = path.join(__dirname, '..', 'assets');
    const svgPath   = path.join(assetsDir, 'logo.svg');
    const pngOut    = path.join(assetsDir, 'icon.png');
    const icoOut    = path.join(assetsDir, 'icon.ico');
    const size      = 512;

    // ── 1. Render SVG → 512×512 PNG via offscreen Chromium ─────────────────
    const html = `<!DOCTYPE html><html><head><style>
      *{margin:0;padding:0;overflow:hidden;}
      body{width:${size}px;height:${size}px;background:transparent;}
      img{width:${size}px;height:${size}px;}
    </style></head><body>
      <img src="file://${svgPath.replace(/\\/g, '/')}"/>
    </body></html>`;

    const tmpHtml = path.join(app.getPath('temp'), 'flo-icon-render.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');

    const win = new BrowserWindow({
      width: size, height: size,
      show: false,
      webPreferences: { offscreen: true }
    });

    // loadFile() returns a Promise that resolves when the page finishes loading
    await win.loadFile(tmpHtml);
    // Extra delay to ensure SVG fully paints
    await new Promise(r => setTimeout(r, 500));

    const img512  = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const png512  = img512.toPNG();
    fs.writeFileSync(pngOut, png512);
    console.log(`✔  Wrote ${pngOut}  (${png512.length} bytes)`);

    win.close();

    // ── 2. Resize to each ICO size using nativeImage ────────────────────────
    const base       = nativeImage.createFromBuffer(png512);
    const pngBuffers = ICO_SIZES.map(s => {
      const resized = base.resize({ width: s, height: s, quality: 'best' });
      return resized.toPNG();
    });

    const icoBuffer = buildIco(pngBuffers, ICO_SIZES);
    fs.writeFileSync(icoOut, icoBuffer);
    console.log(`✔  Wrote ${icoOut}  (sizes: ${ICO_SIZES.join(', ')} px, total: ${icoBuffer.length} bytes)`);

    // Clean up temp file
    try { fs.unlinkSync(tmpHtml); } catch { /* ok */ }

  } catch (err) {
    console.error('Icon generation failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
