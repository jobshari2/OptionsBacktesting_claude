// Draws the app icons (PNG) with no dependencies: a dark tile with a green payoff line. Run: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'www', 'icons');
mkdirSync(OUT, { recursive: true });

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

// Shapes in a 0…1 square. `safe` shrinks the drawing into the maskable safe zone.
function draw(size, { rounded, safe }) {
  const s = safe ? 0.72 : 1;
  const o = (1 - s) / 2;
  const P = (x, y) => [o + x * s, o + y * s];
  const payoff = [P(0.16, 0.7), P(0.42, 0.7), P(0.62, 0.36), P(0.84, 0.36)];
  const axis = [P(0.16, 0.56), P(0.84, 0.56)];
  const bg = [15, 23, 42];
  const green = [52, 211, 153];
  const grey = [100, 116, 139];
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          let inside = true;
          if (rounded) {
            const rad = 0.22;
            const cx = Math.min(Math.max(u, rad), 1 - rad);
            const cy = Math.min(Math.max(v, rad), 1 - rad);
            inside = Math.hypot(u - cx, v - cy) <= rad;
          }
          if (!inside) continue;
          let c = bg;
          if (segDist(u, v, ...axis) < 0.012 * s * 1.6 && Math.floor(u * 40) % 2 === 0) c = grey;
          for (let i = 0; i < payoff.length - 1; i++) if (segDist(u, v, payoff[i], payoff[i + 1]) < 0.045 * s) c = green;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const cov = a / 255;
      buf[i] = cov ? r / cov : 0;
      buf[i + 1] = cov ? g / cov : 0;
      buf[i + 2] = cov ? b / cov : 0;
      buf[i + 3] = a / n;
    }
  return png(size, buf);
}

writeFileSync(join(OUT, 'icon-192.png'), draw(192, { rounded: true }));
writeFileSync(join(OUT, 'icon-512.png'), draw(512, { rounded: true }));
writeFileSync(join(OUT, 'maskable-512.png'), draw(512, { rounded: false, safe: true }));
writeFileSync(
  join(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0f172a"/><path d="M16 56h68" stroke="#64748b" stroke-width="2" stroke-dasharray="2.5 2.5"/><path d="M16 70h26l20-34h22" fill="none" stroke="#34d399" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/></svg>\n`,
);
console.log('icons written to', OUT);
