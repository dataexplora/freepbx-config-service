const { Router } = require('express');
const crypto = require('crypto');
const {
  getNextAvailableExtBlock,
  getNextAvailableRingGroup,
  getNextAvailableDaynightExt,
  createRingGroup,
  createTimeGroupWithSchedule,
  createTimecondition,
  createDaynight,
  createInboundRoute,
  createAnnouncementPair,
  getPool,
} = require('../lib/onboard-db');
const { fwconsoleReload } = require('../lib/reload');
const { createExtensionsViaApi } = require('../lib/freepbx-api');
const { execSync } = require('child_process');

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
    sipPassword,
    phoneNumber,
    extensionCount = 5,
    extensionStart = null,
  } = req.body || {};

  // Validate input
  if (!storeName || !storeSlug || !did) {
    return res.status(400).json({
      error: 'Missing required fields: storeName, storeSlug, did',
    });
  }

  if (!sipPassword) {
    return res.status(400).json({ error: 'Missing sipPassword (Yuboto password)' });
  }

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Missing phoneNumber (real CID, e.g. +302103003551)' });
  }

  if (extensionCount < 1 || extensionCount > 20) {
    return res.status(400).json({ error: 'extensionCount must be 1-20' });
  }

  console.log(`[ONBOARD] Starting onboard for "${storeName}" (DID: ${did}, ${extensionCount} extensions)`);

  // Helper: rollback extensions on failure
  const { deleteExtensionViaApi } = require('../lib/freepbx-api');
  async function rollbackExtensions(extensions) {
    for (const ext of extensions) {
      try { await deleteExtensionViaApi(ext); } catch {}
    }
    console.error(`[ONBOARD] Rolled back ${extensions.length} extensions`);
  }

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

    // Step 2: Create extensions via FreePBX GraphQL API (creates MariaDB + Asterisk DB entries)
    await createExtensionsViaApi(extBlock.start, extensionCount, storeName);
    console.log(`[ONBOARD] Extensions ${extensions.join(',')} created via FreePBX API`);

    // Step 2b: Set custom SIP passwords via SQL
    const pool = getPool();
    const pwConn = await pool.getConnection();
    try {
      for (const ext of extensions) {
        await pwConn.execute(
          "UPDATE sip SET data = ? WHERE id = ? AND keyword = 'secret'",
          [extensionPasswords[ext], String(ext)]
        );
      }
    } finally {
      pwConn.release();
    }
    console.log(`[ONBOARD] Custom SIP passwords set for ${extensions.length} extensions`);

    // Steps 3-8: Create remaining entities in transaction
    let result;
    try {
      result = await createAllEntities({
        storeName,
        storeSlug,
        did,
        extensions,
        rgNum,
        cfExt,
      });
    } catch (txErr) {
      // Transaction failed — rollback extensions
      await rollbackExtensions(extensions);
      throw txErr;
    }

    // Step 9: SIP registration for Yuboto DID
    const fs = require('fs');
    const sipId = `yuboto-${did}`;

    fs.appendFileSync('/etc/asterisk/pjsip.registration_custom.conf', `
[${sipId}]
type=registration
transport=0.0.0.0-udp
outbound_auth=${sipId}-auth
server_uri=sip:sip.yuboto-telephony.gr:5060
client_uri=sip:${did}@sip.yuboto-telephony.gr
contact_user=${did}
retry_interval=60
forbidden_retry_interval=600
expiration=3600
auth_rejection_permanent=no
`);

    fs.appendFileSync('/etc/asterisk/pjsip.auth_custom.conf', `
[${sipId}-auth]
type=auth
auth_type=userpass
username=${did}
password=${sipPassword}
`);

    fs.appendFileSync('/etc/asterisk/pjsip.aor_custom.conf', `
[${sipId}]
type=aor
contact=sip:sip.yuboto-telephony.gr:5060
qualify_frequency=60
`);

    // Step 9b: Outbound endpoint for this DID
    fs.appendFileSync('/etc/asterisk/pjsip.endpoint_custom.conf', `

[${sipId}]
type=endpoint
transport=0.0.0.0-udp
context=from-internal
disallow=all
allow=ulaw,alaw,gsm,g726,g722
aors=${sipId}
outbound_auth=${sipId}-auth
from_domain=sip.yuboto-telephony.gr
from_user=${did}
direct_media=no
rtp_symmetric=yes
dtmf_mode=auto
send_connected_line=no
`);

    // Reload PJSIP so new registration + endpoint are active immediately
    execSync('asterisk -rx "module reload res_pjsip"');
    console.log(`[ONBOARD] SIP registration + outbound endpoint added for ${did} (PJSIP reloaded)`);

    // Step 10: Asterisk DB entries (CLI — no REST API alternative for initial creation)
    execSync(`asterisk -rx "database put DIDMAP ${did} ${phoneNumber}"`);
    execSync(`asterisk -rx "database put DAYNIGHT C${cfExt} NIGHT"`);
    // Outbound trunk mapping + store group: each extension + ring group → its store
    for (const ext of extensions) {
      execSync(`asterisk -rx "database put OUTTRUNK ${ext} ${sipId}"`);
      execSync(`asterisk -rx "database put STOREGROUP ${ext} ${storeSlug}"`);
    }
    execSync(`asterisk -rx "database put STOREGROUP ${rgNum} ${storeSlug}"`);
    console.log(`[ONBOARD] AstDB: DIDMAP + DAYNIGHT C${cfExt} + OUTTRUNK + STOREGROUP for ${extensions.length} exts + RG ${rgNum}`);

    // Step 10b: Time condition to true_sticky via FreePBX REST API
    const { setTimeconditionState } = require('../lib/freepbx-api');
    await setTimeconditionState(result.timeconditionId, 'true_sticky');
    console.log(`[ONBOARD] TC ${result.timeconditionId} set to true_sticky`);

    // Step 10c: Remove feature code (blocked state — no bypass until first payment)
    const pool2 = require('../lib/onboard-db').getPool();
    const conn2 = await pool2.getConnection();
    await conn2.execute(
      'DELETE FROM featurecodes WHERE modulename = ? AND featurename = ?',
      ['daynight', `toggle-mode-${cfExt}`]
    );
    conn2.release();
    console.log(`[ONBOARD] Feature code removed (blocked until payment)`);

    // Step 11: Reload
    let reloadStatus = 'success';
    try {
      await fwconsoleReload();
    } catch (reloadErr) {
      console.error('[ONBOARD] Reload failed:', reloadErr.message);
      reloadStatus = 'failed';
    }

    console.log(`[ONBOARD] Complete: "${storeName}" — ${extensions.length} exts, RG ${rgNum}, CF *${cfExt} (blocked)`);

    // Step 12: Return all IDs
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
        phoneNumber,
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
    extensions,
    rgNum, cfExt,
  } = opts;

  const pool = require('../lib/onboard-db').getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

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
