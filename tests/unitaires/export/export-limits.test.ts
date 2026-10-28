import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { ExportSlots } from "@/shared/services/export/export-slots";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";
import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";

/**
 * What an export may cost a replica.
 *
 * Each one holds a database cursor, a pool connection between batches and
 * the socket for as long as the client reads. Three things went wrong: any
 * number of them ran at once (one company's five dispatchers, or one
 * double-click, held five cursors on the same replica); a failure after the
 * 200 left the client waiting on a download that never ended; and the Excel
 * writer kept building the file for a client that had gone away.
 */

/** A response that accepts everything, and can be closed by the "client". */
class Response extends EventEmitter {
  written: unknown[] = [];
  destroyed = false;
  headersSent = false;
  writableEnded = false;
  writableNeedDrain = false;

  setHeader() {}

  writeHead() {
    this.headersSent = true;
  }

  write(chunk: unknown): boolean {
    this.written.push(chunk);
    return true;
  }

  end() {
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }

  // ExcelJS pipes its zip into the response.
  once(event: string, listener: (...args: unknown[]) => void) {
    return super.once(event, listener);
  }
}

function replyFor(raw: Response, businessId: string | null = "company-a") {
  return {
    raw,
    request: { query: {}, user: { businessId } },
  } as never;
}

const columns = [{ header: "Nome", key: "name" } as never];

/** Rows that wait for the test to let them go. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));

  async function* rows() {
    yield { name: "primeira" };
    await opened;
    yield { name: "segunda" };
  }

  return { rows, open };
}

describe("concurrent exports", () => {
  it("allow one per company and refuse the second with 429 EXPORT_BUSY", async () => {
    const slots = new ExportSlots(3, 1);
    const running = gate();

    const first = new ExportPipeline(
      running.rows(),
      columns,
      new CsvWriter(),
      slots,
    ).execute(replyFor(new Response()), "entregas");

    const refused = await new ExportPipeline(
      gate().rows(),
      columns,
      new CsvWriter(),
      slots,
    )
      .execute(replyFor(new Response()), "entregas")
      .catch((error) => error);

    expect(refused).toBeInstanceOf(ServiceBusyError);
    expect(refused).toMatchObject({ statusCode: 429, code: "EXPORT_BUSY" });
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // Another company is not held back by this one.
    const other = new Response();
    const otherRows = gate();
    const second = new ExportPipeline(
      otherRows.rows(),
      columns,
      new CsvWriter(),
      slots,
    ).execute(replyFor(other, "company-b"), "entregas");

    running.open();
    otherRows.open();
    await Promise.all([first, second]);

    // Finished, the slot is free again.
    expect(slots.inProgress()).toBe(0);

    const again = gate();
    again.open();

    await new ExportPipeline(
      again.rows(),
      columns,
      new CsvWriter(),
      slots,
    ).execute(replyFor(new Response()), "entregas");
  });

  it("cap the replica whatever the companies", () => {
    const slots = new ExportSlots(3, 1);

    slots.acquire("a");
    slots.acquire("b");
    const releaseC = slots.acquire("c");

    expect(() => slots.acquire("d")).toThrow(ServiceBusyError);

    releaseC();
    releaseC(); // idempotent

    expect(slots.inProgress()).toBe(2);
    expect(() => slots.acquire("d")).not.toThrow();
  });
});

describe("a failure after the download started", () => {
  it("cuts the connection instead of leaving the client waiting", async () => {
    const raw = new Response();
    const slots = new ExportSlots();

    async function* rows() {
      yield { name: "primeira" };
      throw new Error("canceling statement due to statement timeout");
    }

    await expect(
      new ExportPipeline(rows(), columns, new CsvWriter(), slots).execute(
        replyFor(raw),
        "entregas",
      ),
    ).resolves.toBeUndefined();

    expect(raw.headersSent).toBe(true);
    expect(raw.destroyed).toBe(true);
    expect(slots.inProgress()).toBe(0);
  });

  it("still answers with the error before the headers", async () => {
    const slots = new ExportSlots();

    // eslint-disable-next-line require-yield
    async function* rows(): AsyncGenerator<{ name: string }> {
      throw new Error("never started");
    }

    const failing = {
      start: async () => {
        throw new Error("could not open the file");
      },
      writeRow: async () => {},
      end: async () => {},
    };

    await expect(
      new ExportPipeline(rows(), columns, failing, slots).execute(
        replyFor(new Response()),
        "entregas",
      ),
    ).rejects.toThrow("could not open the file");
    expect(slots.inProgress()).toBe(0);
  });
});

describe("the Excel writer", () => {
  it("stops pulling rows once the client went away", async () => {
    const raw = new Response();
    let produced = 0;

    async function* rows() {
      for (let index = 0; index < 10_000; index += 1) {
        produced += 1;

        if (index === 5) raw.destroy();

        yield { name: `Cliente ${index}` };
      }
    }

    await new ExportPipeline(
      rows(),
      columns,
      new ExcelWriter(),
      new ExportSlots(),
    ).execute(replyFor(raw), "entregas");

    expect(produced).toBeLessThan(10);
  });
});
