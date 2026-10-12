const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { listGuides, getGuide, saveGuide, deleteGuide } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    res.json(listGuides());
  } catch (err) {
    console.error('guides:list', err);
    res.status(500).json({ error: 'Failed to list guides.' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const guide = getGuide(req.params.id);
    if (!guide) return res.status(404).json({ error: 'Guide not found.' });
    res.json(guide);
  } catch (err) {
    console.error('guides:get', err);
    res.status(500).json({ error: 'Failed to fetch guide.' });
  }
});

router.post('/', (req, res) => {
  try {
    const { title, author = '', steps = [], version = 1 } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required.' });

    const now   = Date.now();
    const guide = { id: uuidv4(), title, author, steps, version, created_at: now, updated_at: now };
    saveGuide(guide);
    res.status(201).json(guide);
  } catch (err) {
    console.error('guides:create', err);
    res.status(500).json({ error: 'Failed to create guide.' });
  }
});

router.put('/:id', (req, res) => {
  try {
    const current = getGuide(req.params.id);
    if (!current) return res.status(404).json({ error: 'Guide not found.' });

    const { title, author, steps, version } = req.body;
    const updated = {
      ...current,
      title:      title   ?? current.title,
      author:     author  ?? current.author,
      steps:      steps   ?? current.steps,
      version:    version ?? current.version,
      updated_at: Date.now(),
    };
    saveGuide(updated);
    res.json(updated);
  } catch (err) {
    console.error('guides:update', err);
    res.status(500).json({ error: 'Failed to update guide.' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    if (!deleteGuide(req.params.id)) return res.status(404).json({ error: 'Guide not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('guides:delete', err);
    res.status(500).json({ error: 'Failed to delete guide.' });
  }
});

module.exports = router;
