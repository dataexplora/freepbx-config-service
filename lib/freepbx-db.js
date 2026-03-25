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

module.exports = {
  getTimegroup,
  replaceTimegroupSchedule,
  scheduleToEntries,
  entriesToSchedule,
};
