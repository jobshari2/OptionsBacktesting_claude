// Zerodha Kite (lib/kite.js): binary tick packets, the instrument list, and the token day.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBinary, parseInstruments, kiteDay } = require('../lib/kite');

// One message holding the given packets: [count u16] then [length u16][packet] each.
function message(packets) {
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16BE(packets.length);
  for (const p of packets) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(p.length);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

function fullPacket({ token, ltp, vol, bid, bidQ, ask, askQ, oi, ltt }) {
  const p = Buffer.alloc(184);
  p.writeUInt32BE(token, 0);
  p.writeInt32BE(Math.round(ltp * 100), 4);
  p.writeUInt32BE(vol, 16);
  p.writeInt32BE(Math.round(ltp * 100), 40); // close
  p.writeUInt32BE(ltt, 44);
  p.writeUInt32BE(oi, 48);
  p.writeUInt32BE(bidQ, 64);
  p.writeInt32BE(Math.round(bid * 100), 68);
  p.writeUInt32BE(askQ, 64 + 5 * 12);
  p.writeInt32BE(Math.round(ask * 100), 68 + 5 * 12);
  return p;
}

test('full option packets carry the price, volume, OI and best bid / ask', () => {
  const token = (12345 << 8) | 2; // NFO-OPT segment
  const [t] = parseBinary(
    message([fullPacket({ token, ltp: 123.45, vol: 987650, bid: 123.4, bidQ: 650, ask: 123.5, askQ: 1300, oi: 4200000, ltt: 1760000000 })]),
  );
  assert.equal(t.token, token);
  assert.equal(t.ltp, 123.45);
  assert.equal(t.vol, 987650);
  assert.equal(t.oi, 4200000);
  assert.equal(t.bid, 123.4);
  assert.equal(t.bidQ, 650);
  assert.equal(t.ask, 123.5);
  assert.equal(t.askQ, 1300);
  assert.equal(t.ltt, 1760000000 * 1000);
});

test('index and LTP packets, several in one message; heartbeats are empty', () => {
  const idx = Buffer.alloc(32);
  idx.writeUInt32BE(256265, 0);
  idx.writeInt32BE(2481235, 4);
  const ltp = Buffer.alloc(8);
  ltp.writeUInt32BE((777 << 8) | 2, 0);
  ltp.writeInt32BE(505, 4);
  const out = parseBinary(message([idx, ltp]));
  assert.equal(out.length, 2);
  assert.equal(out[0].token, 256265);
  assert.equal(out[0].ltp, 24812.35);
  assert.equal(out[1].ltp, 5.05);
  assert.equal(out[1].bid, undefined, 'LTP mode has no quote');
  assert.deepEqual(parseBinary(Buffer.from([0])), []);
});

test('an empty depth level reads as no bid / ask', () => {
  const [t] = parseBinary(message([fullPacket({ token: (1 << 8) | 2, ltp: 0.05, vol: 0, bid: 0, bidQ: 0, ask: 0.1, askQ: 75, oi: 0, ltt: 0 })]));
  assert.equal(t.bid, null);
  assert.equal(t.ask, 0.1);
});

test('the instrument list keeps Nifty options only, keyed by expiry, strike and type', () => {
  const csv = [
    'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
    '10001,39,NIFTY25O1424800CE,"NIFTY",0,2025-10-14,24800.0,0.05,75,CE,NFO-OPT,NFO',
    '10002,40,NIFTY25O1424800PE,"NIFTY",0,2025-10-14,24800.0,0.05,75,PE,NFO-OPT,NFO',
    '10003,41,BANKNIFTY25O1455000CE,"BANKNIFTY",0,2025-10-14,55000.0,0.05,35,CE,NFO-OPT,NFO',
    '10004,42,NIFTY25OCTFUT,"NIFTY",0,2025-10-28,0.0,0.1,75,FUT,NFO-FUT,NFO',
  ].join('\n');
  const map = parseInstruments(csv);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('2025-10-14|24800|CE'), { token: 10001, symbol: 'NIFTY25O1424800CE' });
  assert.equal(map.get('2025-10-14|24800|PE').token, 10002);
});

test('a Kite token is good until 6 AM IST the next day', () => {
  const ist = (s) => Date.parse(s + '+05:30');
  assert.equal(kiteDay(ist('2026-10-14T09:00:00')), '2026-10-14');
  assert.equal(kiteDay(ist('2026-10-15T05:59:00')), '2026-10-14');
  assert.equal(kiteDay(ist('2026-10-15T06:00:00')), '2026-10-15');
});
