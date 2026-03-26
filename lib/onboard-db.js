const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MARIADB_HOST || 'localhost',
  port: Number(process.env.MARIADB_PORT || 3306),
  user: process.env.MARIADB_USER,
  password: process.env.MARIADB_PASS,
  database: process.env.MARIADB_DB || 'asterisk',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

function getPool() { return pool; }

// Default recording IDs for new stores (pre-uploaded generic announcements)
const DEFAULT_NOANSWER_RECORDING_ID = Number(process.env.DEFAULT_NOANSWER_RECORDING_ID || 0);
const DEFAULT_CLOSED_RECORDING_ID = Number(process.env.DEFAULT_CLOSED_RECORDING_ID || 0);

/**
 * SIP template: key-value pairs copied from a reference extension.
 * These get inserted into the `sip` table for each new extension.
 * Fields marked with {REPLACE} are substituted per extension.
 */
const SIP_TEMPLATE = [
  { keyword: 'secret', data: '{PASSWORD}', flags: 2 },
  { keyword: 'dtmfmode', data: 'rfc4733', flags: 3 },
  { keyword: 'defaultuser', data: '', flags: 4 },
  { keyword: 'trustrpid', data: 'yes', flags: 5 },
  { keyword: 'send_connected_line', data: 'yes', flags: 6 },
  { keyword: 'user_eq_phone', data: 'no', flags: 7 },
  { keyword: 'sendrpid', data: 'pai', flags: 8 },
  { keyword: 'qualifyfreq', data: '60', flags: 9 },
  { keyword: 'transport', data: '', flags: 10 },
  { keyword: 'avpf', data: 'no', flags: 11 },
  { keyword: 'icesupport', data: 'no', flags: 12 },
  { keyword: 'rtcp_mux', data: 'no', flags: 13 },
  { keyword: 'namedcallgroup', data: '', flags: 14 },
  { keyword: 'namedpickupgroup', data: '', flags: 15 },
  { keyword: 'disallow', data: '', flags: 16 },
  { keyword: 'allow', data: '', flags: 17 },
  { keyword: 'dial', data: 'PJSIP/{EXT}', flags: 18 },
  { keyword: 'accountcode', data: '', flags: 19 },
  { keyword: 'max_contacts', data: '1', flags: 20 },
  { keyword: 'remove_existing', data: 'yes', flags: 21 },
  { keyword: 'media_use_received_transport', data: 'no', flags: 22 },
  { keyword: 'rtp_symmetric', data: 'yes', flags: 23 },
  { keyword: 'rewrite_contact', data: 'yes', flags: 24 },
  { keyword: 'force_rport', data: 'yes', flags: 25 },
  { keyword: 'mwi_subscription', data: 'auto', flags: 26 },
  { keyword: 'aggregate_mwi', data: 'yes', flags: 27 },
  { keyword: 'bundle', data: 'no', flags: 28 },
  { keyword: 'max_audio_streams', data: '1', flags: 29 },
  { keyword: 'max_video_streams', data: '1', flags: 30 },
  { keyword: 'media_encryption', data: 'no', flags: 31 },
  { keyword: 'timers', data: 'yes', flags: 32 },
  { keyword: 'timers_min_se', data: '90', flags: 33 },
  { keyword: 'direct_media', data: 'yes', flags: 34 },
  { keyword: 'media_address', data: '', flags: 35 },
  { keyword: 'media_encryption_optimistic', data: 'no', flags: 36 },
  { keyword: 'refer_blind_progress', data: 'yes', flags: 37 },
  { keyword: 'device_state_busy_at', data: '0', flags: 38 },
  { keyword: 'match', data: '', flags: 39 },
  { keyword: 'maximum_expiration', data: '7200', flags: 40 },
  { keyword: 'minimum_expiration', data: '60', flags: 41 },
  { keyword: 'rtp_timeout', data: '0', flags: 42 },
  { keyword: 'rtp_timeout_hold', data: '0', flags: 43 },
  { keyword: 'outbound_proxy', data: '', flags: 44 },
  { keyword: 'outbound_auth', data: 'yes', flags: 45 },
  { keyword: 'message_context', data: '', flags: 46 },
  { keyword: 'context', data: 'from-internal', flags: 47 },
  { keyword: 'secret_origional', data: '{PASSWORD}', flags: 48 },
  { keyword: 'sipdriver', data: 'chan_pjsip', flags: 49 },
  { keyword: 'account', data: '{EXT}', flags: 50 },
  { keyword: 'callerid', data: '{CALLERID}', flags: 51 },
];

// --- Allocation functions ---

async function getNextAvailableExtBlock(count) {
  const [rows] = await pool.execute(
    'SELECT extension FROM users WHERE extension >= 101 AND extension < 5000 ORDER BY extension'
  );
  const used = new Set(rows.map(r => Number(r.extension)));

  for (let start = 101; start < 5000 - count; start++) {
    let blockFree = true;
    for (let i = 0; i < count; i++) {
      if (used.has(start + i)) {
        blockFree = false;
        start = start + i; // skip ahead
        break;
      }
    }
    if (blockFree) {
      return { start, end: start + count - 1 };
    }
  }
  throw new Error('No available extension block found');
}

async function getNextAvailableRingGroup() {
  const [rows] = await pool.execute(
    'SELECT grpnum FROM ringgroups WHERE grpnum >= 5000 ORDER BY grpnum DESC LIMIT 1'
  );
  if (rows.length === 0) return 5000;
  return Number(rows[0].grpnum) + 1;
}

async function getNextAvailableDaynightExt() {
  const [rows] = await pool.execute(
    'SELECT DISTINCT ext FROM daynight WHERE ext >= 0 AND ext < 100 ORDER BY ext DESC LIMIT 1'
  );
  if (rows.length === 0) return 0;
  return Number(rows[0].ext) + 1;
}

// --- Creation functions (all take conn for transaction) ---

async function createExtensions(conn, extensions, passwords, storeName) {
  for (let i = 0; i < extensions.length; i++) {
    const ext = extensions[i];
    const password = passwords[ext];
    const name = `${storeName} ${i + 1}`;
    const callerid = `${name} <${ext}>`;

    // Insert into users
    await conn.execute(
      'INSERT INTO users (extension, password, name, voicemail, ringtimer, noanswer, recording, outboundcid, sipname, mohclass) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [String(ext), '', name, 'novm', 0, '', 'out=dontcare|in=dontcare', '', '', 'default']
    );

    // Insert into devices
    await conn.execute(
      'INSERT INTO devices (id, tech, dial, devicetype, user, description, emergency_cid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [String(ext), 'pjsip', `PJSIP/${ext}`, 'fixed', String(ext), name, '']
    );

    // Insert SIP config rows
    for (const row of SIP_TEMPLATE) {
      const data = row.data
        .replace('{EXT}', String(ext))
        .replace('{PASSWORD}', password)
        .replace('{CALLERID}', callerid);

      await conn.execute(
        'INSERT INTO sip (id, keyword, data, flags) VALUES (?, ?, ?, ?)',
        [String(ext), row.keyword, data, row.flags]
      );
    }
  }
}

async function createRingGroup(conn, grpnum, storeName, extensions, noanswerId) {
  const grplist = `${extensions[0]}-${extensions[extensions.length - 1]}`;
  const postdest = noanswerId
    ? `app-announcement-${noanswerId},s,1`
    : 'app-blackhole,hangup,1';

  await conn.execute(
    `INSERT INTO ringgroups (grpnum, strategy, grptime, grppre, grplist, annmsg_id, postdest, description, alertinfo, remotealert_id, needsconf, toolate_id, ringing, cwignore, cfignore, cpickup, recording)
     VALUES (?, 'ringall', 5, '', ?, NULL, ?, ?, '', NULL, '', NULL, 'Ring', '', '', '', 'dontcare')`,
    [String(grpnum), grplist, postdest, storeName]
  );
}

async function createTimeGroupWithSchedule(conn, storeSlug) {
  const [result] = await conn.execute(
    'INSERT INTO timegroups_groups (description) VALUES (?)',
    [storeSlug]
  );
  const tgId = result.insertId;

  const defaultSchedule = [
    '09:00-17:00|mon|*|*',
    '09:00-17:00|tue|*|*',
    '09:00-17:00|wed|*|*',
    '09:00-17:00|thu|*|*',
    '09:00-17:00|fri|*|*',
  ];

  for (const time of defaultSchedule) {
    await conn.execute(
      'INSERT INTO timegroups_details (timegroupid, time) VALUES (?, ?)',
      [tgId, time]
    );
  }

  return tgId;
}

async function createAnnouncementPair(conn, storeSlug) {
  // No-answer announcement
  const [naResult] = await conn.execute(
    'INSERT INTO announcement (description, recording_id, allow_skip, post_dest, return_ivr, noanswer, repeat_msg) VALUES (?, ?, 1, ?, 0, 0, "")',
    [`${storeSlug}-noanswer`, DEFAULT_NOANSWER_RECORDING_ID || null, 'app-blackhole,hangup,1']
  );
  const noanswerId = naResult.insertId;

  // Closed hours announcement
  const [clResult] = await conn.execute(
    'INSERT INTO announcement (description, recording_id, allow_skip, post_dest, return_ivr, noanswer, repeat_msg) VALUES (?, ?, 1, ?, 0, 0, "")',
    [`${storeSlug}-closed`, DEFAULT_CLOSED_RECORDING_ID || null, 'app-blackhole,hangup,1']
  );
  const closedId = clResult.insertId;

  return { noanswerId, closedId };
}

async function createTimecondition(conn, storeSlug, timegroupId, closedAnnouncementId) {
  const falsegoto = closedAnnouncementId
    ? `app-announcement-${closedAnnouncementId},s,1`
    : 'app-blackhole,hangup,1';

  const [result] = await conn.execute(
    'INSERT INTO timeconditions (displayname, time, timezone, truegoto, falsegoto, mode, generate_hints) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`${storeSlug}-open`, timegroupId, 'Europe/Athens', 'custom-vapi-inbound,s,1', falsegoto, 'time-group', 1]
  );
  return result.insertId;
}

async function createDaynight(conn, ext, storeName, timeconditionId, ringGroupNum) {
  // DAY mode → time condition
  await conn.execute(
    'INSERT INTO daynight (ext, dmode, dest, day_recording_id, night_recording_id, fc_description) VALUES (?, ?, ?, 0, 0, ?)',
    [ext, 'day', `timeconditions,${timeconditionId},1`, `${storeName} override`]
  );

  // NIGHT mode → ring group
  await conn.execute(
    'INSERT INTO daynight (ext, dmode, dest, day_recording_id, night_recording_id, fc_description) VALUES (?, ?, ?, 0, 0, ?)',
    [ext, 'night', `ext-group,${ringGroupNum},1`, `${storeName} override`]
  );
}

async function createInboundRoute(conn, did, storeName, callflowExt) {
  await conn.execute(
    'INSERT INTO incoming (cidnum, extension, destination, privacyman, alertinfo, ringing, mohclass, description, grppre, delay_answer, pricid, pmmaxlength, pmminlength, reversal) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?)',
    ['', did, `app-daynight,${callflowExt},1`, '', '', 'default', storeName, '', '', '']
  );
}

module.exports = {
  getPool,
  getNextAvailableExtBlock,
  getNextAvailableRingGroup,
  getNextAvailableDaynightExt,
  createExtensions,
  createRingGroup,
  createTimeGroupWithSchedule,
  createAnnouncementPair,
  createTimecondition,
  createDaynight,
  createInboundRoute,
};
