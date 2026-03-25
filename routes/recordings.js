const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getRecording, createOrUpdateRecording, deleteRecording, createOrUpdateAnnouncement } = require('../lib/freepbx-db');
const { fwconsoleReload } = require('../lib/reload');

const router = Router();

const SOUNDS_DIR = '/var/lib/asterisk/sounds/custom';

/**
 * GET /recordings/:name
 * Check if a recording exists
 */
router.get('/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const recording = await getRecording(name);

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found', name });
    }

    const filePath = path.join(SOUNDS_DIR, `${name}.wav`);
    const fileExists = fs.existsSync(filePath);

    res.json({
      name,
      displayname: recording.displayname,
      recording_id: recording.id,
      file_exists: fileExists,
      file_size: fileExists ? fs.statSync(filePath).size : 0,
    });
  } catch (err) {
    console.error('[RECORDINGS] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /recordings/:name
 * Upload or replace a recording.
 * Expects raw audio body (wav or mp3) with Content-Type header.
 */
router.put('/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const displayName = req.query.displayname || name;

    // Validate name (alphanumeric + hyphens only)
    if (!/^[a-z0-9-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid name. Use lowercase alphanumeric and hyphens only.' });
    }

    // Read raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio body' });
    }

    if (audioBuffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 5MB)' });
    }

    // Ensure sounds directory exists
    if (!fs.existsSync(SOUNDS_DIR)) {
      fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    }

    // Save raw upload to temp file
    const tempPath = path.join(SOUNDS_DIR, `${name}.tmp`);
    const finalPath = path.join(SOUNDS_DIR, `${name}.wav`);
    fs.writeFileSync(tempPath, audioBuffer);

    // Convert to Asterisk-compatible WAV (PCM 16-bit, 8000Hz, mono)
    try {
      execSync(`ffmpeg -y -i "${tempPath}" -ar 8000 -ac 1 -sample_fmt s16 "${finalPath}" 2>/dev/null`);
      fs.unlinkSync(tempPath);
    } catch (convErr) {
      // If ffmpeg fails, try sox
      try {
        execSync(`sox "${tempPath}" -r 8000 -c 1 -b 16 "${finalPath}" 2>/dev/null`);
        fs.unlinkSync(tempPath);
      } catch {
        // Last resort: keep as-is
        fs.renameSync(tempPath, finalPath);
        console.warn('[RECORDINGS] Audio conversion failed, saved raw file');
      }
    }

    // Set ownership to asterisk user
    try { execSync(`chown asterisk:asterisk "${finalPath}"`); } catch {}


    // Create/update DB record
    const recordingId = await createOrUpdateRecording(name, displayName);

    // Auto-create/link announcement if name ends with -noanswer or -closed
    let announcementId = null;
    const announcementType = req.query.type; // 'noanswer' or 'closed'
    if (announcementType === 'noanswer' || announcementType === 'closed' || name.endsWith('-noanswer') || name.endsWith('-closed')) {
      const annDesc = name; // Use recording name as announcement description
      announcementId = await createOrUpdateAnnouncement(annDesc, recordingId, 'app-blackhole,hangup,1');
      console.log(`[RECORDINGS] Linked recording ${recordingId} to announcement ${announcementId}`);
    }

    // Reload dialplan
    let reloadStatus = 'success';
    try {
      await fwconsoleReload();
    } catch (reloadErr) {
      console.error('[RECORDINGS] Reload failed:', reloadErr.message);
      reloadStatus = 'failed';
    }

    res.json({
      ok: true,
      name,
      recording_id: recordingId,
      announcement_id: announcementId,
      file_size: audioBuffer.length,
      reload: reloadStatus,
    });
  } catch (err) {
    console.error('[RECORDINGS] PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /recordings/:name
 * Remove a recording
 */
router.delete('/:name', async (req, res) => {
  try {
    const name = req.params.name;

    const filePath = path.join(SOUNDS_DIR, `${name}.wav`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await deleteRecording(name);

    res.json({ ok: true, name });
  } catch (err) {
    console.error('[RECORDINGS] DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
