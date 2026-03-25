const { Router } = require('express');
const {
  getTimecondition,
  setTimeconditionState,
  STATE_LABELS,
  VALID_STATES,
} = require('../lib/freepbx-api');

const router = Router();

/**
 * GET /ai/:timeconditionId
 * Get current time condition state
 */
router.get('/:timeconditionId', async (req, res) => {
  try {
    const id = Number(req.params.timeconditionId);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid timecondition ID' });
    }

    const data = await getTimecondition(id);
    if (!data || !data.state) {
      return res.status(404).json({ error: 'Time condition not found', timecondition_id: id });
    }

    res.json({
      timecondition_id: id,
      state: data.state,
      state_label: STATE_LABELS[data.state] || data.state,
    });
  } catch (err) {
    console.error('[AI] GET error:', err.message);
    res.status(502).json({ error: 'FreePBX API error', detail: err.message });
  }
});

/**
 * PUT /ai/:timeconditionId
 * Set time condition override state
 */
router.put('/:timeconditionId', async (req, res) => {
  try {
    const id = Number(req.params.timeconditionId);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid timecondition ID' });
    }

    const { state } = req.body || {};
    if (!state || !VALID_STATES.includes(state)) {
      return res.status(400).json({
        error: `Invalid state. Must be one of: ${VALID_STATES.join(', ')}`,
      });
    }

    await setTimeconditionState(id, state);

    res.json({
      ok: true,
      timecondition_id: id,
      state,
      state_label: STATE_LABELS[state],
    });
  } catch (err) {
    console.error('[AI] PUT error:', err.message);
    res.status(502).json({ error: 'FreePBX API error', detail: err.message });
  }
});

module.exports = router;
