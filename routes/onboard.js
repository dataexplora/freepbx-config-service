const { Router } = require('express');
const crypto = require('crypto');
const {
  getNextAvailableExtBlock,
  getNextAvailableRingGroup,
  getNextAvailableDaynightExt,
  createExtensions,
  createRingGroup,
  createTimeGroupWithSchedule,
  createTimecondition,
  createDaynight,
  createInboundRoute,
  createAnnouncementPair,
} = require('../lib/onboard-db');
const { fwconsoleReload } = require('../lib/reload');

const router = Router();

/**
 * POST /onboard
 * Creates all FreePBX entities for a new store in a single transaction.
 */
router.post('/', async (req, res) => {
  const {
    storeName,
    storeSlug,
    did,
    extensionCount = 5,
    extensionStart = null,
  } = req.body || {};

  // Validate input
  if (!storeName || !storeSlug || !did) {
    return res.status(400).json({
      error: 'Missing required fields: storeName, storeSlug, did',
    });
  }

  if (extensionCount < 1 || extensionCount > 20) {
    return res.status(400).json({ error: 'extensionCount must be 1-20' });
  }

  console.log(`[ONBOARD] Starting onboard for "${storeName}" (DID: ${did}, ${extensionCount} extensions)`);

  try {
    // Step 1: Find available numbers
    const extBlock = extensionStart
      ? { start: extensionStart, end: extensionStart + extensionCount - 1 }
      : await getNextAvailableExtBlock(extensionCount);

    const rgNum = await getNextAvailableRingGroup();
    const cfExt = await getNextAvailableDaynightExt();

    console.log(`[ONBOARD] Allocated: extensions ${extBlock.start}-${extBlock.end}, RG ${rgNum}, CF ext ${cfExt}`);

    // Generate passwords
    const extensions = [];
    const extensionPasswords = {};
    for (let i = 0; i < extensionCount; i++) {
      const ext = extBlock.start + i;
      const password = `${storeSlug}${crypto.randomInt(1000, 9999)}`;
      extensions.push(ext);
      extensionPasswords[ext] = password;
    }

    // Steps 2-8: Create everything in transaction
    const result = await createAllEntities({
      storeName,
      storeSlug,
      did,
      extensions,
      extensionPasswords,
      rgNum,
      cfExt,
    });

    // Step 9: Reload dialplan
    let reloadStatus = 'success';
    try {
      await fwconsoleReload();
    } catch (reloadErr) {
      console.error('[ONBOARD] Reload failed:', reloadErr.message);
      reloadStatus = 'failed';
    }

    console.log(`[ONBOARD] Complete: "${storeName}" — ${extensions.length} exts, RG ${rgNum}, CF *${cfExt}`);

    // Step 10: Return all IDs
    res.json({
      ok: true,
      reload: reloadStatus,
      store: {
        extensions,
        extensionPasswords,
        ringGroup: rgNum,
        callflowExt: cfExt,
        timegroupId: result.timegroupId,
        timeconditionId: result.timeconditionId,
        announcementNoanswerId: result.announcementNoanswerId,
        announcementClosedId: result.announcementClosedId,
        inboundDid: did,
      },
    });
  } catch (err) {
    console.error('[ONBOARD] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Orchestrate all DB operations in a single transaction
 */
async function createAllEntities(opts) {
  const {
    storeName, storeSlug, did,
    extensions, extensionPasswords,
    rgNum, cfExt,
  } = opts;

  const pool = require('../lib/onboard-db').getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Step 2: Create PJSIP extensions
    await createExtensions(conn, extensions, extensionPasswords, storeName);

    // Step 5: Create announcements (using default recordings)
    const { noanswerId, closedId } = await createAnnouncementPair(conn, storeSlug);

    // Step 3: Create ring group
    await createRingGroup(conn, rgNum, storeName, extensions, noanswerId);

    // Step 4: Create time group with default schedule
    const timegroupId = await createTimeGroupWithSchedule(conn, storeSlug);

    // Step 6: Create time condition
    const timeconditionId = await createTimecondition(conn, storeSlug, timegroupId, closedId);

    // Step 7: Create call flow control (daynight)
    await createDaynight(conn, cfExt, storeName, timeconditionId, rgNum);

    // Step 8: Create inbound route
    await createInboundRoute(conn, did, storeName, cfExt);

    await conn.commit();

    return {
      timegroupId,
      timeconditionId,
      announcementNoanswerId: noanswerId,
      announcementClosedId: closedId,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = router;
