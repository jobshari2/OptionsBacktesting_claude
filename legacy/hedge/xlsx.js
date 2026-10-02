// Minimal .xlsx reader (no dependencies): unzips the workbook and returns each sheet as rows of
// cell values. Handles shared strings, inline strings and numbers — enough for broker statements.
const zlib = require('zlib');

function unzip(buf) {
  // End of central directory: last occurrence of PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (zip directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .xlsx (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');

// "AB12" -> 0-based column index of "AB"
function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => (files[name] ? files[name]() : null);

  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) {
    for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decode((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }

  const rels = {};
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels[m[1]] = m[2].replace(/^\/?xl\//, '');
  }
  const sheets = {};
  for (const m of (get('xl/workbook.xml') || '').matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const xml = get('xl/' + rels[m[2]]);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
      const row = [];
      for (const c of r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/ r="([A-Z]+\d+)"/) || [])[1];
        const type = (c.match(/ t="([^"]+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (type === 's' && v != null) val = shared[Number(v)];
        else if (type === 'inlineStr') val = decode((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        else if (type === 'str' || type === 'b') val = v != null ? decode(v) : null;
        else if (v != null) val = Number(v);
        if (ref) row[colIndex(ref)] = val;
      }
      const idx = Number((r.match(/ r="(\d+)"/) || [])[1]) - 1;
      rows[idx >= 0 ? idx : rows.length] = row;
    }
    sheets[decode(m[1])] = rows;
  }
  return sheets;
}

module.exports = { readXlsx };
