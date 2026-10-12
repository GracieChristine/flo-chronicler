const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function guidePath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function listGuides() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const guide = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const { steps, ...summary } = guide;
      return { ...summary, step_count: Array.isArray(steps) ? steps.length : 0 };
    })
    .sort((a, b) => b.updated_at - a.updated_at);
}

function getGuide(id) {
  const p = guidePath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveGuide(guide) {
  fs.writeFileSync(guidePath(guide.id), JSON.stringify(guide, null, 2), 'utf8');
}

function deleteGuide(id) {
  const p = guidePath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

module.exports = { listGuides, getGuide, saveGuide, deleteGuide };
