// Generates public/icons/icon-192.png and icon-512.png for the PWA manifest
// without needing any image library or external tool — just a hand-rolled
// PNG encoder (raw RGBA scanlines -> zlib deflate -> IHDR/IDAT/IEND chunks)
// and the classic implicit heart-curve equation to draw the shape. Re-run
// with `npm run icons` any time you want to change the colors/size.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const SIZES = [192, 512];
const BG_COLOR = [10, 10, 13]; // matches --bg in style.css
const HEART_COLOR = [124, 92, 255]; // matches --accent in style.css

// Classic heart curve: (x^2 + y^2 - 1)^3 - x^2*y^3 <= 0 is "inside".
// Coordinates are normalized to roughly [-1.3, 1.3]; y is flipped because
// image coordinates grow downward but the curve expects math coordinates.
function isInsideHeart(x, y) {
  const yy = -y;
  const a = x * x + yy * yy - 1;
  return a * a * a - x * x * yy * yy * yy <= 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = buildCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generatePng(size) {
  // Each row: 1 filter-type byte + size * 4 (RGBA) bytes.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let offset = 0;

  for (let py = 0; py < size; py++) {
    raw[offset++] = 0; // filter type: None
    for (let px = 0; px < size; px++) {
      // Scale factor is deliberately larger than the heart's natural extent
      // so it renders with padding around it — Android's adaptive-icon
      // masking crops toward the center, and a shape drawn edge-to-edge
      // gets clipped.
      const nx = ((px + 0.5) / size - 0.5) * 3.6;
      const ny = ((py + 0.5) / size - 0.5) * 3.6;
      const [r, g, b] = isInsideHeart(nx, ny) ? HEART_COLOR : BG_COLOR;
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = generatePng(size);
  const outPath = path.join(OUTPUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${png.length} bytes)`);
}
