import PDFDocument from "pdfkit";
import QRCode from "qrcode";

import { createHash } from "node:crypto";

import type { ProofDocumentModel } from "@/shared/delivery/proof-document";

/**
 * Draws the receipt, and only draws it.
 *
 * Every decision about WHAT the page says lives in `proof-document`, which is
 * pure and tested field by field. This file owns the part a test cannot read:
 * the bytes. Keeping the two apart is what makes the document assertable at
 * all — an assertion against a rendered PDF can say it is 42 KB, which is
 * equally true of a blank one.
 */
const PAGE_MARGIN = 48;

const INK = "#111111";
const MUTED = "#6b7280";
const RULE = "#d1d5db";

interface RenderedImages {
  /** The receipt photo bytes, when they were still in the bucket. */
  photo: Buffer | null;

  /** The on-screen signature, when the driver captured one. */
  signature: Buffer | null;
}

interface RenderedProof {
  bytes: Buffer;

  /** Of the exact bytes above, hex, lowercase. */
  sha256: string;
}

/**
 * pdfkit throws on a buffer that is not an image it understands, and a
 * corrupt or purged photo must not cost the customer their whole receipt.
 */
function drawImageSafely(
  doc: PDFKit.PDFDocument,
  bytes: Buffer,
  options: { fit: [number, number]; x?: number; y?: number },
): boolean {
  try {
    doc.image(bytes, options.x, options.y, { fit: options.fit });
    return true;
  } catch {
    return false;
  }
}

function drawStamp(
  doc: PDFKit.PDFDocument,
  lines: string[],
  box: { x: number; y: number; width: number },
): void {
  const lineHeight = 11;
  const padding = 6;

  const height = lines.length * lineHeight + padding * 2;
  const top = box.y - height;

  // Semi-opaque so the photo stays readable underneath: a stamp that hides the
  // signature it certifies defeats the purpose.
  doc.save();
  doc.rect(box.x, top, box.width, height).fillOpacity(0.72).fill("#000000");
  doc.restore();

  doc.save();
  doc.fillColor("#ffffff").fontSize(8).font("Helvetica");

  lines.forEach((line, index) => {
    doc.text(line, box.x + padding, top + padding + index * lineHeight, {
      width: box.width - padding * 2,
      lineBreak: false,
      ellipsis: true,
    });
  });

  doc.restore();
}

async function renderProofPdf(
  model: ProofDocumentModel,
  images: RenderedImages,
): Promise<RenderedProof> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: {
      Title: model.headline,
      Author: model.subtitle,
      Creator: "Trajetto",
    },
  });

  const chunks: Buffer[] = [];

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  const contentWidth =
    doc.page.width - PAGE_MARGIN * 2;

  // ------------------------------------------------------------------ header
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18);
  doc.text(model.headline, { width: contentWidth });

  doc.moveDown(0.2);
  doc.fillColor(MUTED).font("Helvetica").fontSize(10);
  doc.text(model.subtitle, { width: contentWidth });

  doc.moveDown(0.8);

  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + contentWidth, doc.y)
    .stroke();

  doc.moveDown(0.8);

  // ---------------------------------------------------------------- sections
  const labelWidth = 150;

  for (const section of model.sections) {
    // A section that would start at the bottom of the page and break across
    // it reads as two half-sections; starting it on the next one is cheaper
    // than the confusion.
    if (doc.y > doc.page.height - PAGE_MARGIN - 90) {
      doc.addPage();
    }

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11);
    doc.text(section.title, { width: contentWidth });

    doc.moveDown(0.35);

    for (const field of section.fields) {
      const top = doc.y;

      doc.fillColor(MUTED).font("Helvetica").fontSize(9);
      doc.text(field.label, PAGE_MARGIN, top, {
        width: labelWidth,
        lineBreak: false,
        ellipsis: true,
      });

      doc.fillColor(INK).font("Helvetica").fontSize(9);
      doc.text(field.value, PAGE_MARGIN + labelWidth, top, {
        width: contentWidth - labelWidth,
      });

      doc.moveDown(0.25);
    }

    doc.moveDown(0.6);
  }

  // ------------------------------------------------------------------ photos
  const hasImages = Boolean(images.photo || images.signature);

  if (hasImages) {
    if (doc.y > doc.page.height - PAGE_MARGIN - 260) {
      doc.addPage();
    }

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11);
    doc.text("Canhoto", { width: contentWidth });

    doc.moveDown(0.4);

    const photoTop = doc.y;
    const photoWidth = contentWidth * 0.58;

    let photoBottom = photoTop;

    if (images.photo) {
      const drawn = drawImageSafely(doc, images.photo, {
        fit: [photoWidth, 230],
        x: PAGE_MARGIN,
        y: photoTop,
      });

      if (drawn) {
        photoBottom = photoTop + 230;

        drawStamp(doc, model.stamp, {
          x: PAGE_MARGIN,
          y: photoBottom,
          width: photoWidth,
        });
      }
    }

    if (!images.photo || photoBottom === photoTop) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9);
      doc.text(
        "A imagem do canhoto não está mais disponível no armazenamento.",
        PAGE_MARGIN,
        photoTop,
        { width: photoWidth },
      );

      photoBottom = doc.y;
    }

    if (images.signature) {
      const signatureX = PAGE_MARGIN + photoWidth + 16;
      const signatureWidth = contentWidth - photoWidth - 16;

      doc.fillColor(MUTED).font("Helvetica").fontSize(9);
      doc.text("Assinatura em tela", signatureX, photoTop, {
        width: signatureWidth,
      });

      drawImageSafely(doc, images.signature, {
        fit: [signatureWidth, 120],
        x: signatureX,
        y: photoTop + 14,
      });
    }

    doc.y = Math.max(photoBottom, photoTop + 240) + 12;
    doc.x = PAGE_MARGIN;
  }

  // --------------------------------------------------------------- the QR
  if (doc.y > doc.page.height - PAGE_MARGIN - 170) {
    doc.addPage();
  }

  const qrTop = doc.y;
  const qrSize = 108;

  // `margin: 0` because the page already has one, and a quiet zone inside a
  // 108pt square is 108pt of code a phone struggles with.
  const qrPng = await QRCode.toBuffer(model.verificationUrl, {
    type: "png",
    margin: 0,
    width: 320,
    errorCorrectionLevel: "M",
  });

  drawImageSafely(doc, qrPng, {
    fit: [qrSize, qrSize],
    x: PAGE_MARGIN,
    y: qrTop,
  });

  const textX = PAGE_MARGIN + qrSize + 16;
  const textWidth = contentWidth - qrSize - 16;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10);
  doc.text("Conferir este comprovante", textX, qrTop, { width: textWidth });

  doc.moveDown(0.3);

  // Printed as well as encoded: a QR that will not scan on a creased printout
  // leaves the reader with nothing, and this line is what they type instead.
  doc.fillColor(MUTED).font("Helvetica").fontSize(8);
  doc.text(model.verificationUrl, textX, doc.y, { width: textWidth });

  doc.moveDown(0.5);
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
  doc.text(model.disclaimer, textX, doc.y, { width: textWidth });

  doc.end();

  await finished;

  const bytes = Buffer.concat(chunks);

  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export { renderProofPdf };
export type { RenderedImages, RenderedProof };
