import { inflateSync } from "node:zlib";

/**
 * Whether a PNG can be handed to pdfkit without taking the process down.
 *
 * pdfkit decodes PNGs that carry transparency (RGBA, grey+alpha, indexed with
 * alpha) through png-js, which inflates the pixel data ASYNCHRONOUSLY and,
 * when that fails, does `throw err` inside the zlib callback. By then
 * `doc.image()` has long returned, so no try/catch around it can see the
 * error: it surfaces as an uncaught exception and the replica dies. A receipt
 * photo with a valid PNG header and a corrupted body — uploaded once, by
 * anyone who can register a delivery — killed whichever replica rendered its
 * PDF, every time somebody opened it.
 *
 * So the same work is done here first, synchronously, where failing is just
 * `false`: the pixel data must inflate, to exactly the size the header
 * promises, with a valid filter byte at the start of every row. Anything this
 * check does not understand is refused rather than guessed at — the receipt
 * then shows "imagem indisponível", which it already knows how to do.
 */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Decoded pixel data above this is refused before inflating: a few kilobytes
 * of deflate can claim gigabytes. 64 MiB is a 4000×4000 RGBA photo.
 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

function channelsFor(colorType: number): number | null {
  switch (colorType) {
    case 0: // greyscale
    case 3: // indexed
      return 1;
    case 4: // greyscale + alpha
      return 2;
    case 2: // RGB
      return 3;
    case 6: // RGBA
      return 4;
    default:
      return null;
  }
}

function isDecodablePng(bytes: Buffer): boolean {
  if (!isPng(bytes)) return false;

  let offset = PNG_SIGNATURE.length;

  let header: {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace: number;
  } | null = null;

  let hasPalette = false;
  const pixelChunks: Buffer[] = [];

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);

    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // The chunk, plus its 4-byte CRC, must fit in what we were given.
    if (dataEnd + 4 > bytes.length) return false;

    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (length !== 13) return false;

      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      hasPalette = true;
    } else if (type === "IDAT") {
      pixelChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!header || pixelChunks.length === 0) return false;
  if (header.width === 0 || header.height === 0) return false;

  const channels = channelsFor(header.colorType);
  if (channels === null) return false;

  if (![1, 2, 4, 8, 16].includes(header.bitDepth)) return false;
  if (header.colorType === 3 && !hasPalette) return false;

  // Adam7 interlacing lays the rows out in seven passes; not worth decoding
  // here for a receipt photo, which a phone camera never produces.
  if (header.interlace !== 0) return false;

  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const expected = header.height * (1 + rowBytes);

  if (!Number.isSafeInteger(expected) || expected > MAX_DECODED_BYTES) {
    return false;
  }

  let pixels: Buffer;

  try {
    pixels = inflateSync(Buffer.concat(pixelChunks), {
      maxOutputLength: expected + 1,
    });
  } catch {
    return false;
  }

  if (pixels.length < expected) return false;

  // Every row starts with its filter type, 0 to 4; png-js throws — in the
  // same unreachable callback — on anything else.
  for (let row = 0; row < header.height; row += 1) {
    if (pixels[row * (1 + rowBytes)] > 4) return false;
  }

  return true;
}

export { isDecodablePng, isPng };
