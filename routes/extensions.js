const { Router } = require('express');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { getNextAvailableExtBlock, getPool } = require('../lib/onboard-db');
const { createExtensionsViaApi, deleteExtensionViaApi } = require('../lib/freepbx-api');
const { fwconsoleReload } = require('../lib/reload');

const router = Router();

/**
 * POST /extensions
 * Add extension(s) to an existing store.
 * Body: { storeSlug, did, sipId, ringGroup, count }
 * - sipId: the trunk name (e.g. "yuboto-20080865")
 * - ringGroup: ring group number to add extensions to
 */
router.post('/', async (req, res) => {
  const { storeSlug, did, sipId, ringGroup, count = 1 } = req.body || {};

  if (!storeSlug || !did || !sipId || !ringGroup) {
    return res.status(400).json({ error: 'Missing required fields: storeSlug, did, sipId, ringGroup' });
  }

  if (count < 1 || count > 10) {
    return res.status(400).json({ error: 'count must be 1-10' });
  }

  console.log(`[EXT] Adding ${count} extension(s) for "${storeSlug}" (RG ${ringGroup})`);

  try {
    // 1. Find next available extension block
    const extBlock = await getNextAvailableExtBlock(count);
    const extensions = [];
    const passwords = {};

    // Get existing 4-digit passwords to ensure uniqueness
    const pool2 = getPool();
    const pwConn = await pool2.getConnection();
    let existingPasswords = new Set();
    try {
      const [rows] = await pwConn.execute(
        "SELECT data FROM sip WHERE keyword = 'secret' AND data REGEXP '^[0-9]{4}$'"
      );
      existingPasswords = new Set(rows.map(r => r.data));
    } finally {
      pwConn.release();
    }

    for (let i = 0; i < count; i++) {
      const ext = extBlock.start + i;
      let password;
      do {
        password = String(crypto.randomInt(1000, 9999));
      } while (existingPasswords.has(password));
      existingPasswords.add(password);
      passwords[ext] = password;
      extensions.push(ext);
    }

    // 2. Create extensions via FreePBX GraphQL API
    await createExtensionsViaApi(extBlock.start, count, storeSlug);
    console.log(`[EXT] Extensions ${extensions.join(',')} created`);

    // 3. Set custom SIP passwords
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      for (const ext of extensions) {
        await conn.execute(
          "UPDATE sip SET data = ? WHERE id = ? AND keyword = 'secret'",
          [passwords[ext], String(ext)]
        );
      }
    } finally {
      conn.release();
    }

    // 4. Update ring group grplist
    const conn2 = await pool.getConnection();
    try {
      const [rows] = await conn2.execute(
        'SELECT grplist FROM ringgroups WHERE grpnum = ?',
        [String(ringGroup)]
      );
      if (rows.length > 0) {
        const currentList = rows[0].grplist;
        const newList = currentList + '-' + extensions.join('-');
        await conn2.execute(
          'UPDATE ringgroups SET grplist = ? WHERE grpnum = ?',
          [newList, String(ringGroup)]
        );
        console.log(`[EXT] Ring group ${ringGroup} updated: ${newList}`);
      }
    } finally {
      conn2.release();
    }

    // 5. Set OUTTRUNK + STOREGROUP per extension
    for (const ext of extensions) {
      execSync(`asterisk -rx "database put OUTTRUNK ${ext} ${sipId}"`);
      execSync(`asterisk -rx "database put STOREGROUP ${ext} ${storeSlug}"`);
    }
    console.log(`[EXT] OUTTRUNK + STOREGROUP set for ${extensions.length} extensions`);

    // 6. Reload
    await fwconsoleReload();

    res.json({
      ok: true,
      extensions,
      passwords,
      ringGroup,
    });
  } catch (err) {
    console.error('[EXT] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /extensions
 * Remove extension(s) from a store.
 * Body: { extensions: [108, 109], ringGroup }
 */
router.delete('/', async (req, res) => {
  const { extensions, ringGroup } = req.body || {};

  if (!extensions || !extensions.length) {
    return res.status(400).json({ error: 'Missing extensions array' });
  }

  console.log(`[EXT] Removing extensions: ${extensions.join(',')}`);

  try {
    // 1. Delete extensions via API
    for (const ext of extensions) {
      try {
        await deleteExtensionViaApi(ext);
      } catch (e) {
        console.warn(`[EXT] API delete failed for ${ext}: ${e.message}`);
      }
      // Remove OUTTRUNK
      try {
        execSync(`asterisk -rx "database del OUTTRUNK ${ext}"`);
      } catch (e) {
        console.error(`[EXT] OUTTRUNK del failed for ${ext}: ${e.message}`);
      }
    }

    // 2. Update ring group — remove extensions from grplist
    if (ringGroup) {
      const pool = getPool();
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.execute(
          'SELECT grplist FROM ringgroups WHERE grpnum = ?',
          [String(ringGroup)]
        );
        if (rows.length > 0) {
          const currentExts = rows[0].grplist.split('-').map(Number);
          const removeSet = new Set(extensions.map(Number));
          const newExts = currentExts.filter(e => !removeSet.has(e));
          const newList = newExts.join('-');
          await conn.execute(
            'UPDATE ringgroups SET grplist = ? WHERE grpnum = ?',
            [newList, String(ringGroup)]
          );
          console.log(`[EXT] Ring group ${ringGroup} updated: ${newList}`);
        }
      } finally {
        conn.release();
      }
    }

    // 3. Reload
    await fwconsoleReload();

    res.json({ ok: true, deleted: extensions });
  } catch (err) {
    console.error('[EXT] Delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
