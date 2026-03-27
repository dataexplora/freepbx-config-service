const { Router } = require('express');
const { execSync } = require('child_process');
const { getCallflow, setCallflowState } = require('../lib/freepbx-api');
const { getPool } = require('../lib/onboard-db');
const { fwconsoleReload } = require('../lib/reload');

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

/**
 * POST /callflow/:ext/block
 * Block AI: force NIGHT + remove feature code so phone toggle doesn't work
 */
router.post('/:ext/block', async (req, res) => {
  try {
    const ext = req.params.ext;
    const pool = getPool();

    // 1. Force NIGHT (AI off)
    await setCallflowState(ext, 'NIGHT');

    // 2. Remove feature code (disables *ext phone toggle)
    await pool.execute(
      'DELETE FROM featurecodes WHERE modulename = ? AND featurename = ?',
      ['daynight', `toggle-mode-${ext}`]
    );

    // 3. Reload
    await fwconsoleReload();

    console.log(`[CALLFLOW] Blocked ext ${ext}: NIGHT + feature code removed`);
    res.json({ ok: true, ext, blocked: true });
  } catch (err) {
    console.error('[CALLFLOW] Block error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /callflow/:ext/unblock
 * Unblock AI: restore DAY + re-create feature code
 * Body: { "storeName": "Pizza Palace" } — needed for feature code description
 */
router.post('/:ext/unblock', async (req, res) => {
  try {
    const ext = req.params.ext;
    const { storeName } = req.body || {};
    const pool = getPool();

    // 1. Force DAY (AI on)
    await setCallflowState(ext, 'DAY');

    // 2. Re-create feature code (if not exists)
    const [existing] = await pool.execute(
      'SELECT featurename FROM featurecodes WHERE modulename = ? AND featurename = ?',
      ['daynight', `toggle-mode-${ext}`]
    );

    if (existing.length === 0) {
      const defaultCode = `*28${ext}`;
      const customCode = `*${ext}`;
      await pool.execute(
        'INSERT INTO featurecodes (modulename, featurename, description, helptext, defaultcode, customcode, enabled, providedest) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
        ['daynight', `toggle-mode-${ext}`, `${ext}: ${storeName || 'Store'} override`, '', defaultCode, customCode]
      );
    }

    // 3. Reload
    await fwconsoleReload();

    console.log(`[CALLFLOW] Unblocked ext ${ext}: DAY + feature code restored`);
    res.json({ ok: true, ext, blocked: false });
  } catch (err) {
    console.error('[CALLFLOW] Unblock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
