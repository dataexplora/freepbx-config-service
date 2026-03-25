const { Router } = require('express');
const { getTimegroup, replaceTimegroupSchedule } = require('../lib/freepbx-db');
const { fwconsoleReload } = require('../lib/reload');

const router = Router();

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * GET /hours/:timegroupId
 * Returns parsed schedule for a time group
 */
router.get('/:timegroupId', async (req, res) => {
  try {
    const id = Number(req.params.timegroupId);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid timegroup ID' });
    }

    const tg = await getTimegroup(id);
    if (!tg) {
      return res.status(404).json({ error: 'Time group not found', timegroup_id: id });
    }

    res.json({
      timegroup_id: tg.id,
      name: tg.name,
      schedule: tg.schedule,
    });
  } catch (err) {
    console.error('[HOURS] GET error:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

/**
 * PUT /hours/:timegroupId
 * Replace time group schedule, then reload dialplan
 */
router.put('/:timegroupId', async (req, res) => {
  try {
    const id = Number(req.params.timegroupId);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid timegroup ID' });
    }

    const { schedule } = req.body || {};
    if (!schedule || typeof schedule !== 'object') {
      return res.status(400).json({ error: 'Missing schedule in request body' });
    }

    // Validate schedule structure
    for (const day of DAYS) {
      if (!schedule[day]) {
        return res.status(400).json({ error: `Missing day: ${day}` });
      }
      const d = schedule[day];
      if (typeof d.open !== 'boolean') {
        return res.status(400).json({ error: `Invalid open value for ${day}` });
      }
      if (d.open) {
        if (!d.start || !d.end) {
          return res.status(400).json({ error: `Missing start/end for ${day}` });
        }
        if (!/^\d{2}:\d{2}$/.test(d.start) || !/^\d{2}:\d{2}$/.test(d.end)) {
          return res.status(400).json({ error: `Invalid time format for ${day}, expected HH:MM` });
        }
      }
    }

    const entriesWritten = await replaceTimegroupSchedule(id, schedule);
    if (entriesWritten === null) {
      return res.status(404).json({ error: 'Time group not found', timegroup_id: id });
    }

    // Reload dialplan
    let reloadStatus = 'success';
    try {
      await fwconsoleReload();
    } catch (reloadErr) {
      console.error('[HOURS] Reload failed after schedule update:', reloadErr.message);
      reloadStatus = 'failed';
    }

    res.json({
      ok: true,
      timegroup_id: id,
      entries_written: entriesWritten,
      reload: reloadStatus,
    });
  } catch (err) {
    console.error('[HOURS] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

module.exports = router;
