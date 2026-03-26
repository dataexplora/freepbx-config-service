const { Router } = require('express');
const { execSync } = require('child_process');
const { getPool } = require('../lib/onboard-db');
const { fwconsoleReload } = require('../lib/reload');

const router = Router();

/**
 * DELETE /teardown
 * Removes all FreePBX entities for a store.
 * Requires explicit IDs to prevent accidental deletion.
 */
router.delete('/', async (req, res) => {
  const {
    storeSlug,
    extensions,        // [104, 105, 106, 107, 108]
    ringGroup,         // 5001
    callflowExt,       // 2
    timegroupId,       // 6
    timeconditionId,   // 5
    did,               // "88888888"
  } = req.body || {};

  if (!storeSlug) {
    return res.status(400).json({ error: 'Missing storeSlug' });
  }

  console.log(`[TEARDOWN] Starting teardown for "${storeSlug}"`);

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Delete inbound route
    if (did) {
      await conn.execute('DELETE FROM incoming WHERE extension = ?', [did]);
      console.log(`[TEARDOWN] Deleted inbound route for DID ${did}`);
    }

    // 2. Delete Call Flow Control + feature code
    if (callflowExt !== undefined && callflowExt !== null) {
      const e = String(callflowExt);
      await conn.execute('DELETE FROM daynight WHERE ext = ?', [e]);
      await conn.execute('DELETE FROM featurecodes WHERE modulename = ? AND featurename = ?',
        ['daynight', `toggle-mode-${e}`]);

      // Remove from Asterisk DB
      try {
        execSync(`asterisk -rx "database del DAYNIGHT C${e}"`);
      } catch {}

      console.log(`[TEARDOWN] Deleted call flow control ext ${e}`);
    }

    // 3. Delete time condition
    if (timeconditionId) {
      await conn.execute('DELETE FROM timeconditions WHERE timeconditions_id = ?', [timeconditionId]);
      console.log(`[TEARDOWN] Deleted time condition ${timeconditionId}`);
    }

    // 4. Delete time group + details
    if (timegroupId) {
      await conn.execute('DELETE FROM timegroups_details WHERE timegroupid = ?', [timegroupId]);
      await conn.execute('DELETE FROM timegroups_groups WHERE id = ?', [timegroupId]);
      console.log(`[TEARDOWN] Deleted time group ${timegroupId}`);
    }

    // 5. Delete announcements
    const annNames = [`${storeSlug}-noanswer`, `${storeSlug}-closed`];
    for (const name of annNames) {
      await conn.execute('DELETE FROM announcement WHERE description = ?', [name]);
    }
    console.log(`[TEARDOWN] Deleted announcements`);

    // 6. Delete ring group
    if (ringGroup) {
      await conn.execute('DELETE FROM ringgroups WHERE grpnum = ?', [String(ringGroup)]);
      console.log(`[TEARDOWN] Deleted ring group ${ringGroup}`);
    }

    // 7. Delete extensions
    if (extensions && extensions.length > 0) {
      const placeholders = extensions.map(() => '?').join(',');
      const strExts = extensions.map(String);

      await conn.execute(`DELETE FROM sip WHERE id IN (${placeholders})`, strExts);
      await conn.execute(`DELETE FROM devices WHERE id IN (${placeholders})`, strExts);
      await conn.execute(`DELETE FROM users WHERE extension IN (${placeholders})`, strExts);
      console.log(`[TEARDOWN] Deleted extensions: ${extensions.join(', ')}`);
    }

    // 8. Delete custom recordings if they exist
    const recNames = [`custom/${storeSlug}-noanswer`, `custom/${storeSlug}-closed`];
    for (const file of recNames) {
      await conn.execute('DELETE FROM recording_files WHERE file = ?', [file]);
    }
    await conn.execute('DELETE FROM recordings WHERE filename IN (?, ?)',
      [`custom/${storeSlug}-noanswer`, `custom/${storeSlug}-closed`]);

    await conn.commit();

    // 9. Reload
    let reloadStatus = 'success';
    try {
      await fwconsoleReload();
    } catch (reloadErr) {
      console.error('[TEARDOWN] Reload failed:', reloadErr.message);
      reloadStatus = 'failed';
    }

    // 10. Delete audio files from disk
    const fs = require('fs');
    const soundsDir = '/var/lib/asterisk/sounds/custom';
    for (const name of [`${storeSlug}-noanswer`, `${storeSlug}-closed`]) {
      for (const ext of ['.ulaw', '.wav']) {
        const path = `${soundsDir}/${name}${ext}`;
        if (fs.existsSync(path)) fs.unlinkSync(path);
      }
    }

    console.log(`[TEARDOWN] Complete: "${storeSlug}"`);

    res.json({
      ok: true,
      reload: reloadStatus,
      deleted: {
        storeSlug,
        extensions: extensions || [],
        ringGroup,
        callflowExt,
        timegroupId,
        timeconditionId,
        did,
      },
    });
  } catch (err) {
    await conn.rollback();
    console.error('[TEARDOWN] Failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
