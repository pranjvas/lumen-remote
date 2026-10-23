// Screen frames from Lumen Eyes: NV12 (Y plane, then interleaved U/V at half height) → RGB → PNG.
// The TV captures a 16:9 screen into a 720x540 (4:3) buffer, so frames are stretched back to 16:9.
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** 8-bit RGB pixels (width*height*3) → PNG. */
export function encodePng(rgb, width, height) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * NV12 (BT.601 limited range) → RGB at outWidth x outHeight. Columns are resampled linearly, so a
 * 720-wide frame becomes 960 wide (16:9) without blocky text; rows map one to one when the heights match.
 */
export function nv12ToRgb(frame, width, height, outWidth = width, outHeight = height) {
  if (frame.length < width * height * 1.5) throw new RangeError('NV12 frame is too short');
  const uvBase = width * height;
  const rgb = Buffer.alloc(outWidth * outHeight * 3);
  const row = new Float32Array(width * 3);
  for (let oy = 0; oy < outHeight; oy++) {
    const y = Math.min(height - 1, Math.floor(((oy + 0.5) * height) / outHeight));
    const uvRow = uvBase + (y >> 1) * width;
    for (let x = 0; x < width; x++) {
      const yy = 1.164 * (frame[y * width + x] - 16);
      const uv = uvRow + (x & ~1);
      const u = frame[uv] - 128;
      const v = frame[uv + 1] - 128;
      row[x * 3] = yy + 1.596 * v;
      row[x * 3 + 1] = yy - 0.392 * u - 0.813 * v;
      row[x * 3 + 2] = yy + 2.017 * u;
    }
    for (let ox = 0; ox < outWidth; ox++) {
      const sx = Math.max(0, Math.min(width - 1, ((ox + 0.5) * width) / outWidth - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const f = sx - x0;
      const o = (oy * outWidth + ox) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = clamp(row[x0 * 3 + c] * (1 - f) + row[x1 * 3 + c] * f);
    }
  }
  return rgb;
}

/** NV12 frame → { png, width, height } at 16:9 (height kept, width = height * 16 / 9). */
export function nv12ToPng(frame, width, height) {
  const outHeight = height;
  const outWidth = Math.round((outHeight * 16) / 9 / 2) * 2;
  return { png: encodePng(nv12ToRgb(frame, width, height, outWidth, outHeight), outWidth, outHeight), width: outWidth, height: outHeight };
}
