import { env } from "@/env";
import {
  NFeParseError,
  parseNFeXml,
  type NFeParsedData,
} from "@/shared/delivery/nfe-parser";

import { CpuPool } from "./cpu-pool";

/** This process's CPU pool (plano-escala F3-29), from CPU_POOL_*. */
const cpuPool = new CpuPool(() => ({
  threads: env.CPU_POOL_THREADS,
  maxPending: env.CPU_POOL_MAX_PENDING,
  timeoutMs: env.CPU_POOL_TIMEOUT_MS,
  maxOldMb: env.CPU_POOL_THREAD_MAX_OLD_MB,
}));

/**
 * An NF-e's parse on the pool, or in process when the pool is off. The
 * parse's own refusal (a file that is not an NF-e) comes back as the same
 * NFeParseError; a pool that is full or a thread that did not answer is a
 * 503 (ServiceBusyError), never a file read as invalid.
 */
async function parseNFeOffThread(
  xml: string,
  pool: CpuPool = cpuPool,
): Promise<NFeParsedData> {
  if (!pool.enabled()) return parseNFeXml(xml);

  try {
    return await pool.run<NFeParsedData>("nfe-parse", xml);
  } catch (error) {
    if (error instanceof Error && error.name === "NFeParseError") {
      throw new NFeParseError(error.message);
    }

    throw error;
  }
}

export { cpuPool, parseNFeOffThread };
