// Settings: the .env file and numbers read from it (or from a request).
const fs = require('fs');

// KEY=value lines of a .env file into process.env; variables that are already set win.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// v as a number, or d when it is missing or not a number.
const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));

module.exports = { loadEnv, num };
