/**
 * Generates the two PNG assets referenced by the manifest (logo + background)
 * with zero dependencies, so the repo stays dependency-free.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, pixel) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y, width, height);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Accent #e11d2e with a soft vertical sheen.
const logo = png(256, 256, (x, y, w, h) => {
  const t = y / h;
  const shade = 1 - t * 0.35;
  return [Math.round(0xe1 * shade), Math.round(0x1d * shade), Math.round(0x2e * shade)];
});

// Dark wide background with a subtle red glow up the left edge.
const bg = png(1200, 600, (x, y, w, h) => {
  const glow = Math.max(0, 1 - x / (w * 0.7));
  const vign = 1 - (y / h) * 0.25;
  const r = Math.round((12 + 90 * glow * glow) * vign);
  const g = Math.round((12 + 8 * glow) * vign);
  const b = Math.round((16 + 18 * glow) * vign);
  return [r, g, b];
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'logo.png'), logo);
fs.writeFileSync(path.join(OUT, 'background.png'), bg);
console.log('wrote public/logo.png and public/background.png');
