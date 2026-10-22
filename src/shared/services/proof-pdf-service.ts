import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { pdfkitAddPlaceholder } from "@signpdf/placeholder-pdfkit";

import { createHash } from "node:crypto";

import type {
  ProofBlock,
  ProofDocumentModel,
  ProofLine,
  ProofSection,
} from "@/shared/delivery/proof-document";
import { isDecodablePng, isPng } from "./png-integrity";
import {
  TRAJETTO_WATERMARK_FRAME,
  TRAJETTO_WATERMARK_PNG,
  TRAJETTO_WATERMARK_SYMBOL,
} from "./proof-assets.generated";
import type { ProofMapImage } from "./proof-location/map-tiles";

/**
 * Draws the receipt in the validated model's layout (decision 14.8), and
 * only draws it.
 *
 * Every decision about WHAT the page says lives in `proof-document`, which is
 * pure and tested field by field. This file owns the part a test can only
 * read back from bytes: where things land, the watermark, the black band
 * with the yellow stamp, the map mosaic, the QR codes and — when the caller
 * asks for it — the empty signature placeholder that `proof-signing` fills.
 */
const PAGE_MARGIN = 40;

const INK = "#111111";
const MUTED = "#4b5563";
const LINK = "#1d4ed8";
const STAMP_YELLOW = "#FFD400";
const BRAND = "#e11d74";

const BODY_SIZE = 8.5;
const LINE_GAP = 2.5;
const BLOCK_GAP = 7;

/** Where the 2nd and 3rd field of a row start, from the margin (as the model). */
const FIELD_COLUMNS = [0, 160, 215];

const MAP_BOX = { width: 200, height: 85 } as const;

/**
 * The band is about as tall as the model's (85pt for a cropped canhoto); a
 * full 4:3 phone photo at this height still leaves a typical receipt on one
 * page with the map, the on-screen signature and the authentication.
 */
const PHOTO_MAX_HEIGHT = 104;
const BAND_PADDING = 8;
const STAMP_HEIGHT = 13;

const QR_SIZE = 92;
const SECONDARY_QR_SIZE = 46;

interface RenderedImages {
  /** The receipt photo bytes, when they were still in the bucket. */
  photo: Buffer | null;

  /** The on-screen signature, when the driver captured one. */
  signature: Buffer | null;

  /** The static map tiles; null without a provider, a fix, or on failure. */
  map?: ProofMapImage | null;
}

/** The empty /Sig dictionary to reserve, when the document will be signed. */
interface SignaturePlaceholder {
  name: string;
  reason: string;
  location: string;
  contactInfo: string;
  subFilter: string;
  /** Bytes reserved for the CMS. */
  signatureLength: number;
}

interface RenderOptions {
  signaturePlaceholder?: SignaturePlaceholder | null;
}

interface RenderedProof {
  bytes: Buffer;

  /** Of the exact bytes above, hex, lowercase. */
  sha256: string;
}

/**
 * Whether pdfkit can take these bytes without taking the process down: a PNG
 * that fails inside zlib's callback escapes every try/catch (png-integrity).
 */
function openImageSafely(
  doc: PDFKit.PDFDocument,
  bytes: Buffer,
): { image: unknown; width: number; height: number } | null {
  if (isPng(bytes) && !isDecodablePng(bytes)) return null;

  try {
    const image = (
      doc as unknown as {
        openImage(src: Buffer): {
          width: number;
          height: number;
          orientation?: number;
        };
      }
    ).openImage(bytes);

    // EXIF orientations 5–8 are drawn rotated: width and height swap.
    const rotated = (image.orientation ?? 1) > 4;

    return {
      image,
      width: rotated ? image.height : image.width,
      height: rotated ? image.width : image.height,
    };
  } catch {
    return null;
  }
}

function drawImage(
  doc: PDFKit.PDFDocument,
  image: unknown,
  x: number,
  y: number,
  size: { width: number; height: number },
): boolean {
  try {
    doc.image(image as Buffer, x, y, size);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Trajetto symbol behind the content, at low opacity: centred on the
 * page, 360pt wide. The frame is mostly empty, so the SYMBOL's box is what
 * gets centred, not the image's.
 */
function drawWatermark(doc: PDFKit.PDFDocument): void {
  const { x, y } = doc;

  const symbolWidth =
    TRAJETTO_WATERMARK_SYMBOL.x1 - TRAJETTO_WATERMARK_SYMBOL.x0;
  const scale = 360 / symbolWidth;

  const centreX =
    (TRAJETTO_WATERMARK_SYMBOL.x0 + TRAJETTO_WATERMARK_SYMBOL.x1) / 2;
  const centreY =
    (TRAJETTO_WATERMARK_SYMBOL.y0 + TRAJETTO_WATERMARK_SYMBOL.y1) / 2;

  doc.save();
  doc.opacity(0.08);
  doc.image(
    TRAJETTO_WATERMARK_PNG,
    doc.page.width / 2 - centreX * scale,
    470 - centreY * scale,
    { width: TRAJETTO_WATERMARK_FRAME.width * scale },
  );
  doc.restore();

  doc.x = x;
  doc.y = y;
}

async function renderProofPdf(
  model: ProofDocumentModel,
  images: RenderedImages,
  options: RenderOptions = {},
): Promise<RenderedProof> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: {
      Title: model.info.title,
      Author: model.info.author,
      Creator: "Trajetto",
      Producer: "Trajetto",
    },
  });

  const chunks: Buffer[] = [];

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  const left = PAGE_MARGIN;
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const right = left + contentWidth;
  const pageBottom = () => doc.page.height - PAGE_MARGIN;

  // The watermark is the first thing on every page, so it sits behind.
  drawWatermark(doc);
  doc.on("pageAdded", () => drawWatermark(doc));

  /** Moves to a new page when `height` would not fit on this one. */
  const ensure = (height: number) => {
    if (doc.y + height > pageBottom()) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
    }
  };

  const sectionTitle = (title: string) => {
    ensure(40);

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10);
    doc.text(title, left, doc.y, { width: contentWidth, lineBreak: false });

    const ruleY = doc.y + 1;

    doc
      .strokeColor(INK)
      .lineWidth(0.6)
      .moveTo(left, ruleY)
      .lineTo(right, ruleY)
      .stroke();

    doc.y = ruleY + 7;
  };

  /**
   * One row of "Label: value" fields. Fields after the first start at the
   * model's columns or right after the previous one, whichever is further.
   * The last field may wrap; the others are cut with an ellipsis.
   */
  const fieldRow = (line: ProofLine, x0: number, width: number) => {
    const top = doc.y;
    let x = x0;
    let bottom = top;

    line.forEach((field, index) => {
      const label = `${field.label}: `;
      const column =
        FIELD_COLUMNS[index] === undefined ? x : x0 + FIELD_COLUMNS[index];

      x = Math.max(x, column);

      doc.font("Helvetica-Bold").fontSize(BODY_SIZE);
      const labelWidth = doc.widthOfString(label);

      const isLast = index === line.length - 1;
      const nextColumn =
        FIELD_COLUMNS[index + 1] === undefined
          ? x0 + width
          : x0 + FIELD_COLUMNS[index + 1];
      const valueX = x + labelWidth;
      const valueWidth = Math.max(
        20,
        (isLast ? x0 + width : nextColumn - 8) - valueX,
      );

      doc.fillColor(INK).font("Helvetica-Bold").fontSize(BODY_SIZE);
      doc.text(label, x, top, { lineBreak: false });

      doc.font("Helvetica").fontSize(BODY_SIZE);
      doc.text(field.value, valueX, top, {
        width: valueWidth,
        ...(isLast
          ? {}
          : { lineBreak: false, ellipsis: true, height: BODY_SIZE + 2 }),
      });

      bottom = Math.max(
        bottom,
        isLast ? doc.y : top + BODY_SIZE + LINE_GAP + 1,
      );

      doc.font("Helvetica").fontSize(BODY_SIZE);
      x = valueX + Math.min(doc.widthOfString(field.value), valueWidth) + 14;
    });

    doc.x = left;
    doc.y = bottom;
  };

  const block = (entry: ProofBlock, x0: number, width: number) => {
    if (entry.heading) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(BODY_SIZE);
      doc.text(entry.heading, x0, doc.y, { width });
    }

    for (const line of entry.lines) fieldRow(line, x0, width);

    for (const note of entry.notes ?? []) {
      doc.fillColor(INK).font("Helvetica").fontSize(BODY_SIZE);
      doc.text(note, x0, doc.y, { width });
    }

    for (const line of entry.trailing ?? []) fieldRow(line, x0, width);
  };

  const section = (entry: ProofSection) => {
    sectionTitle(entry.title);

    entry.blocks.forEach((item, index) => {
      if (index > 0) doc.y += BLOCK_GAP;
      ensure(30);
      block(item, left, contentWidth);
    });

    doc.y += 9;
  };

  // ------------------------------------------------------------------ header
  const headerTop = doc.y;
  const headerHeight = 40;

  doc
    .strokeColor(INK)
    .lineWidth(0.8)
    .rect(left, headerTop, contentWidth, headerHeight)
    .stroke();

  doc.fillColor(INK).font("Helvetica").fontSize(14);
  doc.text(model.header.title, left, headerTop + 5, {
    width: contentWidth,
    align: "center",
    lineBreak: false,
  });
  doc.text(model.header.number, left, headerTop + 22, {
    width: contentWidth,
    align: "center",
    lineBreak: false,
  });

  doc.fillColor(INK).font("Times-Italic").fontSize(7);
  doc.text(model.legalLine, left, headerTop + headerHeight + 4, {
    width: contentWidth,
    align: "center",
  });

  doc.y += 10;

  // ------------------------------------------------- document and delivery
  section(model.sections.document);
  section(model.sections.delivery);

  // ------------------------------------------- protocol: GPS, map, driver
  const protocol = model.sections.protocol;
  const [gpsBlock, ...afterGps] = protocol.blocks;

  sectionTitle(protocol.title);
  ensure(MAP_BOX.height + 50);

  const protocolTop = doc.y;
  const map = images.map && model.map ? images.map : null;

  const textWidth = map ? contentWidth - MAP_BOX.width - 16 : contentWidth;

  if (gpsBlock) block(gpsBlock, left, textWidth);

  let mapBottom = protocolTop;

  if (map) {
    mapBottom =
      drawMap(doc, map, right - MAP_BOX.width, protocolTop) ?? protocolTop;
  }

  doc.y = Math.max(doc.y, mapBottom) + BLOCK_GAP + 4;

  // The on-screen signature is not in the model (design §11 item 3): it
  // goes small, to the right of the driver, where the model leaves blank.
  const signature = images.signature
    ? openImageSafely(doc, images.signature)
    : null;
  const signatureColumn = signature ? 170 : 0;

  for (const [index, item] of afterGps.entries()) {
    ensure(signature && index === 0 ? 70 : 40);

    const top = doc.y;

    block(item, left, contentWidth - signatureColumn);

    if (signature && index === 0) {
      const x = right - signatureColumn + 20;

      doc.fillColor(MUTED).font("Helvetica").fontSize(7);
      doc.text(model.receipt.signatureLabel, x, top, {
        width: signatureColumn - 20,
        lineBreak: false,
      });

      const scale = Math.min(140 / signature.width, 44 / signature.height);
      const size = {
        width: signature.width * scale,
        height: signature.height * scale,
      };

      drawImage(doc, signature.image, x, top + 10, size);

      doc.x = left;
      doc.y = Math.max(doc.y, top + 10 + size.height);
    }

    doc.y += BLOCK_GAP;
  }

  doc.y += 4;

  // ----------------------------------------- receipt photo and the stamp
  const photo = images.photo ? openImageSafely(doc, images.photo) : null;

  const innerWidth = contentWidth - BAND_PADDING * 2;
  const photoScale = photo
    ? Math.min(innerWidth / photo.width, PHOTO_MAX_HEIGHT / photo.height, 1e9)
    : 0;
  const photoSize = photo
    ? { width: photo.width * photoScale, height: photo.height * photoScale }
    : { width: 0, height: 22 };

  const bandHeight = BAND_PADDING + photoSize.height + 4 + STAMP_HEIGHT;

  ensure(bandHeight + 30);
  sectionTitle(model.receipt.title);

  const bandTop = doc.y;

  doc.save();
  doc.rect(left, bandTop, contentWidth, bandHeight).fill("#000000");
  doc.restore();

  const drawnPhoto =
    photo &&
    drawImage(
      doc,
      photo.image,
      left + (contentWidth - photoSize.width) / 2,
      bandTop + BAND_PADDING,
      photoSize,
    );

  if (!drawnPhoto) {
    doc.fillColor("#ffffff").font("Helvetica").fontSize(BODY_SIZE);
    doc.text(
      model.receipt.missingPhoto,
      left + BAND_PADDING,
      bandTop + BAND_PADDING + 4,
      {
        width: innerWidth,
        lineBreak: false,
      },
    );
  }

  // One line, cut with an ellipsis, never wrapped (design §3 #23).
  doc.fillColor(STAMP_YELLOW).font("Helvetica").fontSize(7.5);
  doc.text(
    model.receipt.stamp,
    left + 6,
    bandTop + bandHeight - STAMP_HEIGHT + 3,
    {
      width: contentWidth - 12,
      lineBreak: false,
      ellipsis: true,
      height: 9,
    },
  );

  doc.x = left;
  doc.y = bandTop + bandHeight + 6;

  doc.y += 5;

  // ------------------------------------------------------- authentication
  const auth = model.authentication;
  // Signed: a smaller QR to /verificar sits left of the main one.
  const qrColumnWidth = QR_SIZE + (model.signed ? SECONDARY_QR_SIZE + 10 : 0);
  const columnWidth = contentWidth - qrColumnWidth - 14;

  const measureAuth = () => {
    let height = 0;

    for (const paragraph of auth.paragraphs) {
      doc
        .font(paragraph.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(BODY_SIZE);
      height += doc.heightOfString(paragraph.text, { width: columnWidth });
    }

    doc.font("Helvetica").fontSize(BODY_SIZE);
    for (const step of auth.steps) {
      height += doc.heightOfString(step, { width: columnWidth - 14 });
    }

    const verification = auth.verificationLine ? 30 : 0;
    // Title and rule are about 19pt.
    return Math.max(height + verification, QR_SIZE) + 19;
  };

  ensure(measureAuth());
  sectionTitle(auth.title);

  const authTop = doc.y;

  for (const paragraph of auth.paragraphs) {
    doc
      .fillColor(INK)
      .font(paragraph.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(BODY_SIZE);
    doc.text(paragraph.text, left, doc.y, { width: columnWidth });
  }

  for (const step of auth.steps) {
    doc.fillColor(INK).font("Helvetica").fontSize(BODY_SIZE);
    doc.text(step, left + 14, doc.y, { width: columnWidth - 14 });
  }

  if (auth.verificationLine) {
    doc.y += 4;

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(7.5);
    doc.text(auth.verificationLine.label, left, doc.y, { width: columnWidth });

    // `link` annotates every line the URL wraps onto with the WHOLE address;
    // as plain text a viewer guessed a link for the first line only and
    // opened /verificar/ without the token (DLVB-09, decision 5.11).
    doc.fillColor(LINK).font("Helvetica").fontSize(7.5);
    doc.text(auth.verificationLine.url, left, doc.y, {
      width: columnWidth,
      link: auth.verificationLine.url,
      underline: true,
    });
  }

  const textBottom = doc.y;

  const qrX = right - QR_SIZE;
  await drawQr(doc, auth.qrUrl, qrX, authTop, QR_SIZE);

  let qrBottom = authTop + QR_SIZE;

  // Signed: the main QR is the ITI's validator, as in the model; a smaller
  // one leads to /verificar, where whoever holds the paper downloads the
  // original file to submit there (design §6.6).
  if (model.signed && auth.verificationLine) {
    const secondaryTop = authTop + QR_SIZE - SECONDARY_QR_SIZE - 9;
    const secondaryX = qrX - 10 - SECONDARY_QR_SIZE;

    await drawQr(
      doc,
      auth.verificationLine.url,
      secondaryX,
      secondaryTop,
      SECONDARY_QR_SIZE,
    );

    doc.fillColor(MUTED).font("Helvetica").fontSize(5.5);
    doc.text("Original", secondaryX, secondaryTop + SECONDARY_QR_SIZE + 2, {
      width: SECONDARY_QR_SIZE,
      align: "center",
      lineBreak: false,
    });

    qrBottom = Math.max(qrBottom, secondaryTop + SECONDARY_QR_SIZE + 9);
  }

  doc.x = left;
  doc.y = Math.max(textBottom, qrBottom);

  // Reserved last, on the last page: the signature covers everything above.
  if (options.signaturePlaceholder) {
    const placeholder = options.signaturePlaceholder;

    pdfkitAddPlaceholder({
      pdf: doc,
      pdfBuffer: Buffer.alloc(0),
      reason: placeholder.reason,
      contactInfo: placeholder.contactInfo,
      name: placeholder.name,
      location: placeholder.location,
      subFilter: placeholder.subFilter,
      signatureLength: placeholder.signatureLength,
      // Invisible widget, as in the model.
      widgetRect: [0, 0, 0, 0],
      appName: "Trajetto",
    });
  }

  doc.end();

  await finished;

  const bytes = Buffer.concat(chunks);

  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** A QR code that is also a link: on a screen, clicking it is what people try. */
async function drawQr(
  doc: PDFKit.PDFDocument,
  url: string,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  // `margin: 0` because the page already has one, and a quiet zone inside a
  // small square is code a phone struggles with.
  const png = await QRCode.toBuffer(url, {
    type: "png",
    margin: 0,
    width: 320,
    errorCorrectionLevel: "M",
  });

  if (drawImage(doc, png, x, y, { width: size, height: size })) {
    doc.link(x, y, size, size, url);
  }
}

/**
 * The map mosaic, clipped to its box, with the marker and the provider's
 * attribution. Returns the box's bottom, or null when nothing was drawn.
 */
function drawMap(
  doc: PDFKit.PDFDocument,
  map: ProofMapImage,
  x: number,
  y: number,
): number | null {
  const scale = MAP_BOX.width / map.width;
  const height = map.height * scale;

  // The tiles are validated before they get here (map-tiles), but a bad one
  // must still not cost the whole receipt.
  const opened = map.tiles.map((tile) => ({
    tile,
    image: openImageSafely(doc, tile.bytes),
  }));

  if (opened.some((entry) => !entry.image)) return null;

  doc.save();
  doc.rect(x, y, MAP_BOX.width, height).clip();

  for (const { tile, image } of opened) {
    drawImage(doc, image!.image, x + tile.left * scale, y + tile.top * scale, {
      width: 256 * scale,
      height: 256 * scale,
    });
  }

  // The marker: brand colour with a white ring, drawn, not a bitmap.
  doc
    .circle(x + map.marker.x * scale, y + map.marker.y * scale, 4)
    .lineWidth(1.5)
    .fillAndStroke(BRAND, "#ffffff");

  doc.font("Helvetica").fontSize(5);
  const credit = map.attribution;
  const creditWidth = Math.min(doc.widthOfString(credit) + 4, MAP_BOX.width);

  doc
    .rect(x + MAP_BOX.width - creditWidth, y + height - 7, creditWidth, 7)
    .fillOpacity(0.8)
    .fill("#ffffff");

  doc.fillOpacity(1).fillColor(INK);
  doc.text(credit, x + MAP_BOX.width - creditWidth + 2, y + height - 6, {
    width: creditWidth,
    lineBreak: false,
    ellipsis: true,
  });

  doc.restore();

  doc
    .strokeColor(INK)
    .lineWidth(0.6)
    .rect(x, y, MAP_BOX.width, height)
    .stroke();

  return y + height;
}

export { PAGE_MARGIN, renderProofPdf };
export type {
  RenderOptions,
  RenderedImages,
  RenderedProof,
  SignaturePlaceholder,
};
