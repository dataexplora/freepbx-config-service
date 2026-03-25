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

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Get time group by ID with parsed schedule
 */
async function getTimegroup(id) {
  const [groups] = await pool.execute(
    'SELECT id, description FROM timegroups_groups WHERE id = ?',
    [id]
  );
  if (groups.length === 0) return null;

  const [details] = await pool.execute(
    'SELECT id, time FROM timegroups_details WHERE timegroupid = ?',
    [id]
  );

  return {
    id: groups[0].id,
    name: groups[0].description,
    schedule: entriesToSchedule(details),
  };
}

/**
 * Replace all time group entries with new schedule.
 * Runs in a transaction: DELETE old → INSERT new.
 */
async function replaceTimegroupSchedule(timegroupId, schedule) {
  // Verify time group exists
  const [groups] = await pool.execute(
    'SELECT id FROM timegroups_groups WHERE id = ?',
    [timegroupId]
  );
  if (groups.length === 0) return null;

  const entries = scheduleToEntries(schedule);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      'DELETE FROM timegroups_details WHERE timegroupid = ?',
      [timegroupId]
    );

    for (const entry of entries) {
      await conn.execute(
        'INSERT INTO timegroups_details (timegroupid, time) VALUES (?, ?)',
        [timegroupId, entry]
      );
    }

    await conn.commit();
    return entries.length;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Convert dashboard schedule to FreePBX time entries.
 * Input:  { mon: { open: true, start: "09:00", end: "17:00" }, ... }
 * Output: ["09:00-17:00|mon|*|*", ...]
 */
function scheduleToEntries(schedule) {
  const entries = [];
  for (const day of DAYS) {
    const d = schedule[day];
    if (d && d.open && d.start && d.end) {
      entries.push(`${d.start}-${d.end}|${day}|*|*`);
    }
  }
  return entries;
}

/**
 * Convert FreePBX time entries to dashboard schedule.
 * Input:  [{ time: "09:00-17:00|mon|*|*" }, ...]
 * Output: { mon: { open: true, start: "09:00", end: "17:00" }, ... }
 */
function entriesToSchedule(entries) {
  const schedule = {};
  for (const day of DAYS) {
    schedule[day] = { open: false, start: '00:00', end: '00:00' };
  }

  for (const entry of entries) {
    const parts = entry.time.split('|');
    if (parts.length < 2) continue;

    const [timeRange, day] = parts;
    const [start, end] = timeRange.split('-');

    if (DAYS.includes(day) && start && end) {
      schedule[day] = { open: true, start, end };
    }
  }

  return schedule;
}

// --- System Recordings ---

async function getRecording(name) {
  const [rows] = await pool.execute(
    'SELECT r.id, r.displayname FROM recordings r JOIN recording_files rf ON rf.file = ? WHERE r.id = (SELECT MIN(r2.id) FROM recordings r2 JOIN recording_files rf2 ON rf2.file = ? WHERE r2.displayname LIKE ?)',
    [`custom/${name}`, `custom/${name}`, `%${name}%`]
  );
  if (rows.length > 0) return rows[0];

  // Fallback: search by displayname
  const [rows2] = await pool.execute(
    'SELECT id, displayname FROM recordings WHERE displayname = ?',
    [name]
  );
  return rows2[0] || null;
}

async function createOrUpdateRecording(name, displayName) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Check if recording exists
    const [existing] = await conn.execute(
      'SELECT id FROM recordings WHERE displayname = ?',
      [displayName]
    );

    let recordingId;
    if (existing.length > 0) {
      recordingId = existing[0].id;
    } else {
      const [result] = await conn.execute(
        'INSERT INTO recordings (displayname, description) VALUES (?, ?)',
        [displayName, `Custom recording: ${displayName}`]
      );
      recordingId = result.insertId;
    }

    // Upsert recording_files
    const filePath = `custom/${name}`;
    await conn.execute(
      'REPLACE INTO recording_files (file, duration, updated) VALUES (?, 0, UNIX_TIMESTAMP())',
      [filePath]
    );

    await conn.commit();
    return recordingId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function deleteRecording(name) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM recording_files WHERE file = ?', [`custom/${name}`]);
    await conn.execute('DELETE FROM recordings WHERE displayname = ?', [name]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// --- Announcements ---

async function getAnnouncement(id) {
  const [rows] = await pool.execute(
    'SELECT announcement_id, description, recording_id, post_dest FROM announcement WHERE announcement_id = ?',
    [id]
  );
  return rows[0] || null;
}

async function createOrUpdateAnnouncement(description, recordingId, postDest) {
  // Check if announcement with this description exists
  const [existing] = await pool.execute(
    'SELECT announcement_id FROM announcement WHERE description = ?',
    [description]
  );

  if (existing.length > 0) {
    await pool.execute(
      'UPDATE announcement SET recording_id = ? WHERE announcement_id = ?',
      [recordingId, existing[0].announcement_id]
    );
    return existing[0].announcement_id;
  }

  const [result] = await pool.execute(
    'INSERT INTO announcement (description, recording_id, allow_skip, post_dest, return_ivr, noanswer, repeat_msg) VALUES (?, ?, 1, ?, 0, 0, "")',
    [description, recordingId, postDest || 'app-blackhole,hangup,1']
  );
  return result.insertId;
}

async function linkRecordingToAnnouncement(announcementId, recordingId) {
  await pool.execute(
    'UPDATE announcement SET recording_id = ? WHERE announcement_id = ?',
    [recordingId, announcementId]
  );
}

module.exports = {
  getTimegroup,
  replaceTimegroupSchedule,
  scheduleToEntries,
  entriesToSchedule,
  getRecording,
  createOrUpdateRecording,
  deleteRecording,
  getAnnouncement,
  createOrUpdateAnnouncement,
  linkRecordingToAnnouncement,
};
