// Appends errors from the server and the browser to logs/errors.log (one line per error, IST time).
// Repeats of the same message within a minute are collapsed so a failing poll loop can't flood the file.
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.log');
const lastSeen = new Map();

function logError(source, err, extra) {
  const msg = err instanceof Error ? err.message : String(err);
  const key = `${source}|${msg}`;
  const now = Date.now();
  if (now - (lastSeen.get(key) || 0) < 60_000) return;
  lastSeen.set(key, now);

  const time = new Date(now + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 23);
  let line = `${time} IST [${source}] ${msg}`;
  if (extra) line += ` | ${extra}`;
  const stack =
    err instanceof Error && err.stack
      ? err.stack
          .split('\n')
          .slice(1, 4)
          .map((s) => s.trim())
          .join(' < ')
      : '';
  if (stack) line += ` | ${stack}`;
  console.error(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line.replace(/\r?\n/g, ' ') + '\n');
  } catch {}
}

module.exports = { logError, LOG_FILE };
