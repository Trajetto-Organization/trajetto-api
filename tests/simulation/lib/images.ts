import { deflateSync } from "node:zlib";

/**
 * The pictures the virtual phones "take": small PNGs drawn in memory, so a
 * run carries no binary fixture and the web shows something recognisable —
 * a receipt stub with printed lines, a handwritten-looking signature, a
 * closed door for "Cliente ausente", a dashboard for the checklist.
 *
 * PNG and not JPEG only because Node can write one with zlib alone; the API
 * accepts both for every photo field (config/upload.ts, MIME_TYPES.images).
 */
type Rgb = [number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

/** An RGB PNG from a per-pixel painter. */
function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgb,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc((width * 3 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);

    raw[row] = 0; // filter: none

    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const at = row + 1 + x * 3;

      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Deterministic per seed, so two stops never share the same picture. */
function hashSeed(seed: string): number {
  let hash = 2166136261;

  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

/** A receipt stub on a clipboard: paper, printed lines, a stamp. */
function receiptPhoto(seed: string): Buffer {
  const shift = hashSeed(seed) % 17;

  return png(320, 240, (x, y) => {
    const onPaper = x > 30 && x < 290 && y > 18 && y < 222;

    if (!onPaper) return [92, 74, 58];

    const line =
      (y - 40 - shift) % 18 === 0 && x > 50 && x < 270 - ((y * 7) % 60);
    const stamp =
      (x - 220) ** 2 + (y - 180) ** 2 < 26 ** 2 && (x + y) % 5 !== 0;

    if (stamp) return [40, 70, 160];
    if (line) return [70, 70, 70];

    return [244, 240, 228];
  });
}

/** A signature: a looping stroke across a white pad. */
function signatureImage(seed: string): Buffer {
  const phase = (hashSeed(seed) % 628) / 100;

  return png(360, 140, (x, y) => {
    const curve = 70 + 28 * Math.sin(x / 19 + phase) + 12 * Math.sin(x / 7);
    const stroke = Math.abs(y - curve) < 2.2 && x > 24 && x < 336;

    return stroke ? [20, 30, 90] : [255, 255, 255];
  });
}

/** A closed door with its number: the "Cliente ausente" photo. */
function closedDoorPhoto(seed: string): Buffer {
  const tone = hashSeed(seed) % 40;

  return png(240, 320, (x, y) => {
    const door = x > 60 && x < 180 && y > 40 && y < 300;
    const knob = (x - 165) ** 2 + (y - 175) ** 2 < 36;
    const plate = x > 100 && x < 140 && y > 70 && y < 92;

    if (knob) return [212, 175, 55];
    if (plate) return [230, 230, 230];
    if (door) return [110 + tone, 66, 38];

    return [200, 196, 188];
  });
}

/** A dashboard dial for the checklist photos. */
function checklistPhoto(seed: string): Buffer {
  const needle = (hashSeed(seed) % 180) * (Math.PI / 180);

  return png(240, 180, (x, y) => {
    const dx = x - 120;
    const dy = 150 - y;
    const radius = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    if (radius < 92 && radius > 86 && dy > 0) return [220, 220, 220];
    if (radius < 80 && dy > 0 && Math.abs(angle - needle) < 0.03)
      return [230, 60, 40];

    return [24, 26, 32];
  });
}

export {
  checklistPhoto,
  closedDoorPhoto,
  crc32,
  png,
  receiptPhoto,
  signatureImage,
};
