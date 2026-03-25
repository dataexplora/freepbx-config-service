const { Router } = require('express');
const { getCallflow, setCallflowState } = require('../lib/freepbx-api');

const router = Router();

/**
 * GET /callflow/:ext
 * Get current call flow control state (DAYNIGHT)
 */
router.get('/:ext', async (req, res) => {
  try {
    const ext = req.params.ext;
    const data = await getCallflow(ext);

    if (!data || data.state === undefined) {
      return res.status(404).json({ error: 'Call flow control not found', ext });
    }

    res.json({
      ext,
      state: data.state,
      ai_active: data.state === 'DAY',
    });
  } catch (err) {
    console.error('[CALLFLOW] GET error:', err.message);
    res.status(502).json({ error: 'FreePBX API error', detail: err.message });
  }
});

/**
 * PUT /callflow/:ext
 * Set call flow control state
 * Body: { "state": "DAY" } or { "state": "NIGHT" }
 */
router.put('/:ext', async (req, res) => {
  try {
    const ext = req.params.ext;
    const { state } = req.body || {};

    if (!state || !['DAY', 'NIGHT'].includes(state)) {
      return res.status(400).json({ error: 'Invalid state. Must be DAY or NIGHT' });
    }

    await setCallflowState(ext, state);

    res.json({
      ok: true,
      ext,
      state,
      ai_active: state === 'DAY',
    });
  } catch (err) {
    console.error('[CALLFLOW] PUT error:', err.message);
    res.status(502).json({ error: 'FreePBX API error', detail: err.message });
  }
});

module.exports = router;
