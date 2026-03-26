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

    fs.appendFileSync('/etc/asterisk/pjsip.endpoint_custom.conf', `
[${sipId}]
type=endpoint
transport=0.0.0.0-udp
context=from-trunk
disallow=all
allow=alaw,ulaw
outbound_auth=${sipId}-auth
aors=${sipId}
from_domain=sip.yuboto-telephony.gr
from_user=${did}
contact_user=${did}
rewrite_contact=yes
rtp_symmetric=yes
force_rport=yes
direct_media=no
t38_udptl=no
send_rpid=yes
trust_id_inbound=yes
trust_id_outbound=yes
`);

    fs.appendFileSync('/etc/asterisk/pjsip.aor_custom.conf', `
[${sipId}]
type=aor
contact=sip:sip.yuboto-telephony.gr:5060
qualify_frequency=60
`);

    fs.appendFileSync('/etc/asterisk/pjsip_custom.conf', `
[identify-${sipId}]
type=identify
endpoint=${sipId}
match=sip.yuboto-telephony.gr
`);

    console.log(`[ONBOARD] SIP registration added for ${did}`);

    // Step 10: DIDMAP + DAYNIGHT in Asterisk DB
    try {
      execSync(`asterisk -rx "database put DIDMAP ${did} ${phoneNumber}"`);
      execSync(`asterisk -rx "database put DAYNIGHT C${cfExt} DAY"`);
    } catch (e) {
      console.warn('[ONBOARD] Failed to init Asterisk DB entries:', e.message);
    }

    // Step 11: Reload
    let reloadStatus = 'success';
    try {
      await fwconsoleReload();
    } catch (reloadErr) {
      console.error('[ONBOARD] Reload failed:', reloadErr.message);
      reloadStatus = 'failed';
    }

    console.log(`[ONBOARD] Complete: "${storeName}" — ${extensions.length} exts, RG ${rgNum}, CF *${cfExt}`);

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
