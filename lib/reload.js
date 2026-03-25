const { exec } = require('child_process');

/**
 * Run `fwconsole reload` to regenerate Asterisk dialplan.
 * Required after any MariaDB changes to time groups.
 * Can take 5-15 seconds.
 */
function fwconsoleReload() {
  return new Promise((resolve, reject) => {
    console.log('[RELOAD] Running fwconsole reload...');

    exec('fwconsole reload', { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[RELOAD] Failed:', err.message);
        if (stderr) console.error('[RELOAD] stderr:', stderr);
        reject(new Error(`fwconsole reload failed: ${err.message}`));
        return;
      }

      console.log('[RELOAD] Success:', stdout.trim());
      resolve(stdout.trim());
    });
  });
}

module.exports = { fwconsoleReload };
