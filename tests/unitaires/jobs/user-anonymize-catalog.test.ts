import { beforeEach, describe, expect, it, vi } from "vitest";

const { log, sendCatalogChangedEvent } = vi.hoisted(() => {
  const log: string[] = [];

  return {
    log,
    sendCatalogChangedEvent: vi.fn((businessId: string, entity: string) => {
      log.push(`catalogChanged:${entity}:${businessId}`);
    }),
  };
});

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent }));
vi.mock("@/../infra/database", () => ({
  default: {},
  databaseBatch: {},
}));

import type { JobContext } from "@/shared/jobs/job-runner";
import { createUserAnonymizeJob } from "@/shared/jobs/user-anonymize/user-anonymize-job";

/**
 * The USER_ANONYMIZE job and the driver catalogue (audit of 25/11/2026).
 *
 * The job turns a driver INACTIVE and "Motorista removido", yet it told no
 * open screen: the web's selectors trust `catalogChanged` driver for two
 * minutes and the app's driver list refetches on it, so both kept offering
 * the old name until then. Every other driver write announces after its
 * commit; the job now does the same, once, right after the identity phase
 * commits — never about a transaction that rolled back, and never for a
 * subject that is gone or a panel login (no catalogue lists one). The SQL
 * itself is the E2E's (tests/E2E/user-anonymize.test.ts); here the
 * transactions are a stub that logs when they commit.
 */

const COMPANY = "018fe000-0000-7000-8000-00000000000a";
const DRIVER = "018fe000-0000-7000-8000-0000000000d1";
const LOGIN = "018fe000-0000-7000-8000-0000000000u1";

type Row = Record<string, unknown>;

/** A transaction client whose reads answer `rows` and whose writes count 0. */
function stubTx(rows: Row[]) {
  return {
    $queryRaw: async () => rows,
    $executeRaw: async () => 0,
    $executeRawUnsafe: async () => 0,
  };
}

function stubDeps({
  subject,
  failIdentity = false,
}: {
  subject: Row | null;
  failIdentity?: boolean;
}) {
  const db = {
    async $transaction(work: (tx: unknown) => Promise<unknown>) {
      if (failIdentity) {
        log.push("rollback");
        throw new Error("identity transaction failed");
      }

      const result = await work(stubTx(subject ? [subject] : []));

      log.push("commit");

      return result;
    },
  };
  const batch = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work(stubTx([])),
    $queryRaw: async () => [{ present: false }],
  };

  return {
    db: db as never,
    batch: batch as never,
    uploads: () => ({
      listObjectKeys: async () => [],
      deleteFileOutcome: async () => "deleted" as const,
    }),
    activities: () => ({ createActivityIfEnabled: async () => undefined }),
  };
}

/** A job resumed at the identity phase: the audit trail is already done. */
function jobAt(subject: "driver" | "user", subjectId: string): JobContext {
  return {
    id: "job-1",
    kind: "USER_ANONYMIZE",
    businessId: COMPANY,
    subjectId,
    attempts: 1,
    maxAttempts: 5,
    payload: { subject, subjectId, businessId: COMPANY, requestedById: null },
    progress: {
      v: 1,
      phase: "identity",
      driverId: null,
      userId: null,
      table: 0,
      cursor: "",
      trailRows: 0,
      events: 0,
      objects: 0,
    },
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    throwIfStopped: () => undefined,
  } as JobContext;
}

const DRIVER_ROW = {
  driver_id: DRIVER,
  driver_name: "João",
  user_id: LOGIN,
  user_name: "João",
  email: "joao@example.com",
};

describe("USER_ANONYMIZE tells the company's screens the driver changed", () => {
  beforeEach(() => {
    log.length = 0;
    sendCatalogChangedEvent.mockClear();
  });

  it("emits catalogChanged driver once, after the identity commit", async () => {
    const job = createUserAnonymizeJob(stubDeps({ subject: DRIVER_ROW }));

    await job.run(jobAt("driver", DRIVER));

    expect(sendCatalogChangedEvent).toHaveBeenCalledTimes(1);
    expect(sendCatalogChangedEvent).toHaveBeenCalledWith(COMPANY, "driver");
    const told = log.indexOf(`catalogChanged:driver:${COMPANY}`);

    expect(told).toBeGreaterThan(log.indexOf("commit"));
  });

  it("emits nothing when the identity transaction rolls back", async () => {
    const job = createUserAnonymizeJob(
      stubDeps({ subject: DRIVER_ROW, failIdentity: true }),
    );

    await expect(job.run(jobAt("driver", DRIVER))).rejects.toThrow();

    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });

  it("emits nothing when the driver is gone", async () => {
    const job = createUserAnonymizeJob(stubDeps({ subject: null }));

    await job.run(jobAt("driver", DRIVER));

    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });

  it("emits nothing for a panel login, which no catalogue lists", async () => {
    const job = createUserAnonymizeJob(
      stubDeps({
        subject: { id: LOGIN, name: "Ana", email: "ana@example.com" },
      }),
    );

    await job.run(jobAt("user", LOGIN));

    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });
});
