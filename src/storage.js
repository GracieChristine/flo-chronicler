// Guide persistence: individual JSON files at userData/guides/{id}.json
// Version history: previous versions archived at userData/guides/history/{id}-v{n}.json
// Up to MAX_HISTORY_VERSIONS previous versions are kept per guide.

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_HISTORY_VERSIONS = 10;

function guidesDir() {
  const dir = path.join(app.getPath('userData'), 'guides');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function historyDir() {
  const dir = path.join(guidesDir(), 'history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listGuides() {
  const dir = guidesDir();
  // Only JSON files directly in guides/ — not the history/ subfolder
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('-v'));
  const summaries = [];
  for (const f of files) {
    try {
      const guide = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      summaries.push({
        id:        guide.id,
        title:     guide.title,
        stepCount: (guide.steps || []).length,
        updatedAt: guide.updatedAt,
        version:   guide.version ?? 0  // preserve 0 for drafts; ?? avoids falsy coercion
      });
    } catch { /* skip corrupt files */ }
  }
  // ISO 8601 sorts lexicographically === chronologically — string compare is safe
  summaries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return summaries;
}

function loadGuide(id) {
  const file = path.join(guidesDir(), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Load a specific historical version of a guide.
function loadGuideVersion(id, version) {
  const file = path.join(historyDir(), `${id}-v${version}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// List available history versions for a guide (sorted newest first).
function listGuideVersions(id) {
  const dir = historyDir();
  if (!fs.existsSync(dir)) return [];
  const prefix = `${id}-v`;
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { version: g.version, updatedAt: g.updatedAt, stepCount: (g.steps || []).length };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.version - a.version);
}

// Build a fingerprint of the user-visible content of a guide (title + steps).
// Only content that the user can edit is included — metadata like id, version,
// and updatedAt are intentionally excluded so that re-saving without changes
// doesn't falsely count as a new version.
function contentFingerprint(g) {
  return JSON.stringify({
    title: g.title || '',
    steps: (g.steps || []).map(s => ({
      text:              s.text || '',
      screenshotDataUrl: s.screenshotDataUrl || '',
      // Include subSteps text so splitting a step also registers as a change
      subSteps: (s.subSteps || []).map(ss => ss.text || '')
    }))
  });
}

function saveGuide(g) {
  const id = g.id || crypto.randomUUID();

  // Load the current on-disk version (if any) to see if content changed
  const existing = loadGuide(id);
  let newVersion;

  if (existing) {
    const prevVersion = existing.version;

    if (prevVersion === 0) {
      // First real save of a recorder draft → always promote to v1.
      // Drafts are never archived (there's no user-visible history to preserve).
      newVersion = 1;
    } else if (contentFingerprint(existing) !== contentFingerprint(g)) {
      // Published guide with changed content → bump version and archive the old one
      newVersion = (prevVersion || 1) + 1;

      const archivePath = path.join(historyDir(), `${id}-v${prevVersion}.json`);
      fs.writeFileSync(archivePath, JSON.stringify(existing, null, 2), 'utf8');

      // Prune oldest history files if we exceed the cap
      const allVersions = listGuideVersions(id);
      if (allVersions.length > MAX_HISTORY_VERSIONS) {
        const toDelete = allVersions.slice(MAX_HISTORY_VERSIONS);
        for (const v of toDelete) {
          try {
            fs.unlinkSync(path.join(historyDir(), `${id}-v${v.version}.json`));
          } catch { /* best effort */ }
        }
      }
    } else {
      // Published guide, content unchanged → keep version, just update metadata
      newVersion = prevVersion || 1;
    }
  } else {
    // New guide: treat as draft (version 0) if explicitly flagged, otherwise v1
    newVersion = (g.version === 0) ? 0 : 1;
  }

  const guide = { ...g, id, version: newVersion, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(guidesDir(), `${id}.json`), JSON.stringify(guide, null, 2), 'utf8');
  return guide;
}

function deleteGuide(id) {
  // Delete current version
  const file = path.join(guidesDir(), `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);

  // Delete all history versions
  try {
    const dir = historyDir();
    const prefix = `${id}-v`;
    fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
  } catch { /* history dir might not exist yet */ }

  return { ok: true };
}

module.exports = { listGuides, loadGuide, loadGuideVersion, listGuideVersions, saveGuide, deleteGuide };
