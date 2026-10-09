import { parentPort } from "node:worker_threads";

import type { ProofDocumentModel } from "@/shared/delivery/proof-document";
import type { ProofMapImage } from "./proof-location/map-tiles";
import { renderProofPdf, type SignaturePlaceholder } from "./proof-pdf-service";

/**
 * The receipt renderer, on its own thread (see proof-pdf-renderer.ts).
 *
 * Kept tiny on purpose: this file is its own build entry, and everything it
 * imports is bundled into it — pdfkit, the QR encoder, the PNG gate, the
 * embedded watermark and the signature placeholder — and nothing from the
 * rest of the API. The signing key never comes here.
 */
interface RenderRequest {
  id: number;
  model: ProofDocumentModel;
  photo: Uint8Array | null;
  signature: Uint8Array | null;
  map: ProofMapImage | null;
  signaturePlaceholder: SignaturePlaceholder | null;
}

// The structured clone hands buffers over as plain Uint8Arrays; a view over
// the same memory is enough, no second copy.
const asBuffer = (bytes: Uint8Array | null): Buffer | null =>
  bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;

parentPort?.on("message", async (request: RenderRequest) => {
  try {
    const map = request.map
      ? {
          ...request.map,
          tiles: request.map.tiles.map((tile) => ({
            ...tile,
            bytes: asBuffer(tile.bytes as Uint8Array) as Buffer,
          })),
        }
      : null;

    const rendered = await renderProofPdf(
      request.model,
      {
        photo: asBuffer(request.photo),
        signature: asBuffer(request.signature),
        map,
      },
      { signaturePlaceholder: request.signaturePlaceholder },
    );

    // Copied, not transferred: pdfkit's output may sit in Node's shared
    // buffer pool, and transferring that would detach it for everyone.
    parentPort?.postMessage({
      id: request.id,
      bytes: rendered.bytes,
      sha256: rendered.sha256,
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
