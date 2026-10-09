import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { ProofDocumentModel } from "@/shared/delivery/proof-document";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";

import {
  renderProofPdf,
  type RenderOptions,
  type RenderedImages,
  type RenderedProof,
} from "./proof-pdf-service";

const log = logger.child({ component: "proof-renderer" });

/**
 * Renders receipt PDFs on a worker thread instead of the request's event loop.
 *
 * pdfkit does real CPU work synchronously — for a receipt photo with
 * transparency it splits the alpha channel pixel by pixel before compressing
 * — and on the request thread that held every HTTP request and socket of the
 * replica for ~100 ms per render on a fast desktop, more on a production
 * vCPU. `?regenerate=true` made it repeatable on demand. Here the main loop
 * only copies bytes across.
 *
 * It also contains a crash: a PNG that fails inside a zlib callback (the
 * ST-01 class, which the integrity gate is meant to stop) now takes down this
 * worker, not the replica — the pending renders fail and the next one starts
 * a fresh worker.
 *
 * One worker per process, created on first use: renders are rare (a receipt
 * is built only when somebody opens it) and never need parallelism of their
 * own, only to be off the main thread.
 */
const RENDER_TIMEOUT_MS = 20_000;

/** Renders queued or running at once; past this, answer 503 at once. */
const MAX_PENDING_RENDERS = 8;

interface Pending {
  resolve: (rendered: RenderedProof) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;

  /** The worker the render was sent to; only its loss fails this entry. */
  owner: Worker;
}

type WorkerReply =
  | { id: number; bytes: Uint8Array; sha256: string }
  | { id: number; error: string };

let worker: Worker | null = null;
let nextId = 0;

const pending = new Map<number, Pending>();

let warnedInProcess = false;

const busy = () =>
  new AppError(
    "Muitos comprovantes sendo gerados agora. Tente novamente em instantes.",
    503,
    "PROOF_RENDER_BUSY",
  );

const timedOut = () =>
  new AppError(
    "O comprovante demorou demais para ser gerado. Tente novamente.",
    503,
    "PROOF_RENDER_TIMEOUT",
  );

const restarted = () =>
  new AppError(
    "O gerador de comprovantes foi reiniciado. Tente novamente.",
    503,
    "PROOF_RENDER_UNAVAILABLE",
  );

/**
 * Fails what was sent to a worker that is gone. Only ITS renders: after a
 * timeout a replacement may already be serving new ones.
 */
function failRendersOf(owner: Worker): void {
  for (const [id, entry] of pending) {
    if (entry.owner !== owner) continue;

    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(restarted());
  }
}

/**
 * The worker, started on demand.
 *
 * Production runs the bundle tsup builds next to server.js
 * (`build/proof-pdf-worker.js`, see tsup.config.ts). Development and tests run
 * TypeScript through tsx, so the worker loads tsx's require hook before the
 * source. Null when neither exists — the caller then renders in process
 * rather than failing the receipt.
 */
function startWorker(): Worker | null {
  const built = path.join(__dirname, "proof-pdf-worker.js");
  const source = path.join(__dirname, "proof-pdf-worker.ts");

  let started: Worker;

  if (fs.existsSync(built)) {
    started = new Worker(built);
  } else if (fs.existsSync(source)) {
    started = new Worker(
      `require("tsx/cjs"); require(${JSON.stringify(source)});`,
      { eval: true },
    );
  } else {
    return null;
  }

  // Never what keeps the process alive: shutdown waits for requests, not
  // for an idle renderer.
  started.unref();

  started.on("message", (reply: WorkerReply) => {
    const entry = pending.get(reply.id);

    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(reply.id);

    if ("error" in reply) {
      entry.reject(new Error(`Proof render failed: ${reply.error}`));
      return;
    }

    const bytes = Buffer.from(
      reply.bytes.buffer,
      reply.bytes.byteOffset,
      reply.bytes.byteLength,
    );

    entry.resolve({ bytes, sha256: reply.sha256 });
  });

  const lost = () => {
    if (worker === started) worker = null;

    failRendersOf(started);
  };

  started.on("error", (error: unknown) => {
    log.error({ err: error }, "proof PDF worker failed");
    lost();
  });

  started.on("exit", lost);

  return started;
}

async function renderProofPdfOffThread(
  model: ProofDocumentModel,
  images: RenderedImages,
  {
    timeoutMs = RENDER_TIMEOUT_MS,
    ...options
  }: { timeoutMs?: number } & RenderOptions = {},
): Promise<RenderedProof> {
  if (pending.size >= MAX_PENDING_RENDERS) throw busy();

  worker ??= startWorker();

  if (!worker) {
    if (!warnedInProcess) {
      warnedInProcess = true;

      log.warn("proof PDF worker not found; rendering on the main thread");
    }

    return renderProofPdf(model, images, options);
  }

  const current = worker;
  const id = (nextId += 1);

  return new Promise<RenderedProof>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(timedOut());

      // The worker is stuck on this render, and everything queued behind it
      // would wait just as long. A fresh one serves the next request.
      if (worker === current) worker = null;
      void current.terminate();
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer, owner: current });

    try {
      // The placeholder carries only the /Sig dictionary's public fields:
      // the certificate and its key never reach the worker (proof-signing).
      current.postMessage({
        id,
        model,
        photo: images.photo,
        signature: images.signature,
        map: images.map ?? null,
        signaturePlaceholder: options.signaturePlaceholder ?? null,
      });
    } catch (error) {
      // A model that cannot be cloned never reached the worker; its timer
      // must not later terminate a worker that is fine.
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Stops the worker. For tests and shutdown; the next render starts a new one. */
async function shutdownProofRenderer(): Promise<void> {
  const current = worker;

  worker = null;

  if (current) await current.terminate();
}

export {
  MAX_PENDING_RENDERS,
  renderProofPdfOffThread,
  shutdownProofRenderer,
};
