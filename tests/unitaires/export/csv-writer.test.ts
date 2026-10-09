import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import {
  CsvWriter,
  ExportAbortedError,
  neutralizeFormula,
} from "@/shared/services/export/writers/csv-writer";

/**
 * A CSV the dispatcher opens in Excel.
 *
 * Two defects. Cells starting with = + - @ ran as formulas — the CSV quotes
 * are the file's delimiter, not an escape Excel honours — and they carry
 * names, notes and addresses typed by drivers and customers. And the writer
 * ignored backpressure: a client that read slowly, or not at all, made the
 * process buffer the whole export in memory while the database kept feeding
 * rows.
 */
describe("formula injection", () => {
  it.each([
    ['=HYPERLINK("https://evil","Clique")', `'=HYPERLINK("https://evil","Clique")`],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
    ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
    ["\t=1+1", "'\t=1+1"],
  ])("neutralises %s", (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it.each(["-150", "-150,00", "+3.5", "Padaria Central", "Rua 1, 100"])(
    "leaves %s as it is",
    (input) => {
      expect(neutralizeFormula(input)).toBe(input);
    },
  );
});

/** A socket whose buffer is always full until somebody says "drain". */
class SlowResponse extends EventEmitter {
  written: string[] = [];
  destroyed = false;

  setHeader() {}
  writeHead() {}

  write(chunk: string): boolean {
    this.written.push(chunk);
    return false;
  }

  end() {}
}

function replyFor(raw: SlowResponse) {
  return { raw } as never;
}

describe("backpressure", () => {
  it("does not pull the next row until the socket drains", async () => {
    const raw = new SlowResponse();
    let produced = 0;

    async function* rows() {
      for (let index = 0; index < 1_000; index += 1) {
        produced += 1;
        yield { name: `Cliente ${index}` };
      }
    }

    const running = new ExportPipeline(
      rows(),
      [{ header: "Nome", key: "name" } as never],
      new CsvWriter(),
    ).execute(replyFor(raw), "entregas");

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Before: all thousand rows were pulled and buffered in milliseconds.
    expect(produced).toBeLessThanOrEqual(1);

    raw.destroyed = true;
    raw.emit("close");

    await running;
  });

  it("stops when the client goes away, instead of waiting forever", async () => {
    const raw = new SlowResponse();
    const writer = new CsvWriter();

    // The header line also waits for the socket; let it through.
    const starting = writer.start(
      replyFor(raw),
      [{ header: "Nome", key: "name" } as never],
      "x",
    );

    raw.emit("drain");
    await starting;

    const pending = writer.writeRow({ name: "Cliente" });
    raw.emit("close");

    await expect(pending).rejects.toBeInstanceOf(ExportAbortedError);
  });
});
