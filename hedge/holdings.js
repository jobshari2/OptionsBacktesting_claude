// Reads a broker holdings statement (.xlsx) into a flat list of holdings with their current value.
// Looks for a header row containing "Symbol" and "ISIN" on each sheet; prefers the "Combined"
// sheet when present, otherwise merges all sheets (de-duplicated by ISIN).
const { readXlsx } = require('./xlsx');

function parseHoldings(buf) {
  const sheets = readXlsx(buf);
  const names = Object.keys(sheets);
  const order = names.some((n) => /combined/i.test(n)) ? names.filter((n) => /combined/i.test(n)) : names;
  const out = new Map();
  let asOf = null;

  for (const name of order) {
    const rows = sheets[name] || [];
    for (const r of rows) {
      const title = (r || []).find((v) => typeof v === 'string' && /as on \d{4}-\d{2}-\d{2}/.test(v));
      if (title) asOf = title.match(/(\d{4}-\d{2}-\d{2})/)[1];
    }
    const h = rows.findIndex((r) => r && r.some((v) => v === 'Symbol') && r.some((v) => v === 'ISIN'));
    if (h < 0) continue;
    const head = Array.from(rows[h], (v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''));
    const col = (...keys) => head.findIndex((x) => keys.some((k) => x === k || x.startsWith(k)));
    const c = {
      symbol: col('symbol'),
      isin: col('isin'),
      sector: col('sector'),
      type: col('instrument type'),
      qty: col('quantity available'),
      avg: col('average price'),
      close: col('previous closing price'),
    };
    for (const r of rows.slice(h + 1)) {
      if (!r) continue;
      const isin = r[c.isin];
      const qty = Number(r[c.qty]);
      const close = Number(r[c.close]);
      if (typeof isin !== 'string' || !/^[A-Z0-9]{12}$/.test(isin) || !(qty > 0) || !(close > 0)) continue;
      const sector = c.sector >= 0 ? String(r[c.sector] ?? '').replace(/^-$/, '') : '';
      const itype = c.type >= 0 ? String(r[c.type] ?? '').replace(/^-$/, '') : '';
      const isFund = Boolean(itype) && !/^-?$/.test(itype);
      const kind = isFund ? 'mf' : sector.toUpperCase() === 'ETF' || isin.startsWith('INF') ? 'etf' : 'stock';
      out.set(isin, {
        symbol: String(r[c.symbol]).trim(),
        isin,
        kind, // stock | etf | mf
        category: isFund ? itype : sector || (kind === 'etf' ? 'ETF' : ''),
        qty,
        avg: Number(r[c.avg]) || null,
        price: close,
        value: qty * close,
      });
    }
  }
  const list = [...out.values()].sort((a, b) => b.value - a.value);
  if (!list.length) throw new Error('No holdings found: expected a sheet with "Symbol", "ISIN", "Quantity Available" and "Previous Closing Price" columns');
  return { asOf, holdings: list };
}

module.exports = { parseHoldings };
