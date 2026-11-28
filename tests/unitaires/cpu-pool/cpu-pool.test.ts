import { monitorEventLoopDelay } from "node:perf_hooks";
import { PassThrough } from "node:stream";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";

import { CpuPool, type CpuPoolSettings } from "@/shared/cpu-pool/cpu-pool";
import { parseNFeOffThread } from "@/shared/cpu-pool";
import { NFeParseError, parseNFeXml } from "@/shared/delivery/nfe-parser";
import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";

/**
 * The CPU pool (plano-escala F3-29), with real worker threads (the source
 * through tsx, as in development):
 *
 *  - an NF-e parsed on a thread is the NF-e parsed in process, and a file
 *    that is not one is refused with the same NFeParseError;
 *  - the main thread keeps answering while 25 big NF-e are parsed: the
 *    event loop's p99 stays under 100 ms (the plan's measurement);
 *  - a full line is a 503 CPU_POOL_BUSY at once; a thread that does not
 *    answer is a 503 CPU_POOL_TIMEOUT and is replaced; a thread that dies
 *    fails only its own call;
 *  - each thread gets the heap ceiling CPU_POOL_THREAD_MAX_OLD_MB;
 *  - an Excel workbook built on a thread is a real .xlsx with every row,
 *    and a workbook session leaves a thread for the short tasks;
 *  - an export that finds no thread free for a workbook builds it in
 *    process at once, never waiting in line for another one's download;
 *  - with CPU_POOL_THREADS=0 the work runs in process, as before.
 */

const ACCESS_KEY = "35240612345678000199550010000012341000012345";

/** An NF-e with `items` products: 990 is the most an NF-e may carry. */
function nfe(items = 1): string {
  const det = Array.from(
    { length: items },
    (_, index) => `<det nItem="${index + 1}">
        <prod>
          <xProd>Produto número ${index + 1} da carga</xProd>
          <qCom>12.0000</qCom>
          <uCom>CX</uCom>
          <vUnCom>4.5000</vUnCom>
        </prod>
      </det>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${ACCESS_KEY}" versao="4.00">
      <ide><nNF>1234</nNF><dhEmi>2026-08-18T09:30:00-03:00</dhEmi></ide>
      <emit><CNPJ>12345678000199</CNPJ><xNome>Indústria LTDA</xNome></emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado Central ME</xNome>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr><nro>450</nro><xBairro>Centro</xBairro>
          <xMun>Campinas</xMun><UF>SP</UF><CEP>13010000</CEP>
        </enderDest>
      </dest>
      ${det}
    </infNFe>
  </NFe>
  <protNFe><infProt><chNFe>${ACCESS_KEY}</chNFe></infProt></protNFe>
</nfeProc>`;
}

const pools: CpuPool[] = [];

function poolWith(
  settings: Partial<CpuPoolSettings> = {},
  entry?: ConstructorParameters<typeof CpuPool>[1],
): CpuPool {
  const pool = new CpuPool(
    () => ({
      threads: 2,
      maxPending: 16,
      timeoutMs: 20_000,
      maxOldMb: 64,
      ...settings,
    }),
    entry,
  );

  pools.push(pool);

  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe("the CPU pool", () => {
  it("parses an NF-e on a thread exactly as in process", async () => {
    const pool = poolWith();
    const xml = nfe(3);

    expect(await parseNFeOffThread(xml, pool)).toEqual(parseNFeXml(xml));
    expect(pool.state().threads).toBe(1);
  }, 30_000);

  it("refuses a file that is not an NF-e with the parser's own error", async () => {
    const pool = poolWith();
    const bad = "<html><body>não é uma nota</body></html>";
    let inProcess: unknown;

    try {
      parseNFeXml(bad);
    } catch (error) {
      inProcess = error;
    }

    const offThread = parseNFeOffThread(bad, pool);

    await expect(offThread).rejects.toBeInstanceOf(NFeParseError);
    await expect(offThread).rejects.toThrow((inProcess as Error).message);
  }, 30_000);

  it("keeps the event loop free while 25 big NF-e are parsed", async () => {
    const pool = poolWith();
    const xml = nfe(990);

    // The threads up and warm: the measurement is of the parses.
    await Promise.all([
      parseNFeOffThread(xml, pool),
      parseNFeOffThread(xml, pool),
    ]);

    const lag = monitorEventLoopDelay({ resolution: 10 });

    lag.enable();

    for (let file = 0; file < 25; file += 1) {
      await parseNFeOffThread(xml, pool);
    }

    lag.disable();

    expect(lag.percentile(99) / 1e6).toBeLessThan(100);
  }, 120_000);

  it("refuses at once when the line is full, and serves the line in order", async () => {
    // One thread, held by a workbook; one call may wait.
    const pool = poolWith({ threads: 1, maxPending: 1 });
    const session = (await pool.openWorkbook(
      [{ header: "A", key: "a" }],
      () => undefined,
    ))!;

    const waiting = parseNFeOffThread(nfe(), pool);

    await expect(parseNFeOffThread(nfe(), pool)).rejects.toMatchObject({
      statusCode: 503,
      code: "CPU_POOL_BUSY",
    });

    await session.end();

    expect((await waiting).invoice_key).toBe(ACCESS_KEY);
  }, 30_000);

  it("replaces a thread that does not answer, with a 503", async () => {
    const pool = poolWith({ timeoutMs: 300 }, () => ({
      file: "require('node:worker_threads').parentPort.on('message', () => {});",
      eval: true,
    }));

    await expect(pool.run("nfe-parse", "x")).rejects.toMatchObject({
      statusCode: 503,
      code: "CPU_POOL_TIMEOUT",
    });
    expect(pool.state().threads).toBe(0);
  }, 30_000);

  it("fails only the call of a thread that dies", async () => {
    const pool = poolWith({}, () => ({
      file: "require('node:worker_threads').parentPort.on('message', () => process.exit(3));",
      eval: true,
    }));

    await expect(pool.run("nfe-parse", "x")).rejects.toMatchObject({
      statusCode: 503,
      code: "CPU_POOL_UNAVAILABLE",
    });
    expect(pool.state()).toMatchObject({ threads: 0, busy: 0 });
  }, 30_000);

  it("gives each thread the heap ceiling of CPU_POOL_THREAD_MAX_OLD_MB", async () => {
    const pool = poolWith({ maxOldMb: 48 }, () => ({
      file: [
        "const { parentPort } = require('node:worker_threads');",
        "const { getHeapStatistics } = require('node:v8');",
        "parentPort.on('message', ({ id }) => parentPort.postMessage({",
        "  type: 'result', id, value: getHeapStatistics().heap_size_limit,",
        "}));",
      ].join("\n"),
      eval: true,
    }));

    const limitMb = (await pool.run<number>("nfe-parse", "x")) / 1024 / 1024;

    // The old generation's 48 MB plus the young generation's own spaces.
    expect(limitMb).toBeGreaterThanOrEqual(48);
    expect(limitMb).toBeLessThan(128);
  }, 30_000);

  it("builds an Excel workbook on a thread, every row in it", async () => {
    const pool = poolWith();
    const chunks: Buffer[] = [];
    const session = (await pool.openWorkbook(
      [
        { header: "Destinatário", key: "name" },
        { header: "Valor", key: "value", width: 12 },
      ],
      (bytes) => chunks.push(Buffer.from(bytes)),
    ))!;

    for (let batch = 0; batch < 3; batch += 1) {
      await session.write(
        Array.from({ length: 400 }, (_, index) => ({
          name: `Cliente ${batch * 400 + index + 1}`,
          value: batch * 400 + index + 1,
        })),
      );
    }

    await session.end();

    const book = new ExcelJS.Workbook();

    await book.xlsx.load(Buffer.concat(chunks) as never);

    const sheet = book.getWorksheet("Relatório");

    expect(sheet?.rowCount).toBe(1 + 1200);
    expect(sheet?.getRow(1).values).toEqual([, "Destinatário", "Valor"]);
    expect(sheet?.getRow(1201).values).toEqual([, "Cliente 1200", 1200]);
  }, 60_000);

  it("leaves a thread for the short tasks while a workbook holds one", async () => {
    const pool = poolWith({ threads: 2 });
    const session = (await pool.openWorkbook(
      [{ header: "A", key: "a" }],
      () => undefined,
    ))!;

    // No thread for a second workbook, at once and without a place in
    // line; the NF-e takes the other thread at once.
    expect(
      await pool.openWorkbook([{ header: "A", key: "a" }], () => {}),
    ).toBeNull();
    expect(pool.state().waiting).toBe(0);
    expect((await parseNFeOffThread(nfe(), pool)).invoice_key).toBe(ACCESS_KEY);

    await session.end();
    expect(
      await pool.openWorkbook([{ header: "A", key: "a" }], () => {}),
    ).not.toBeNull();
  }, 30_000);

  it("builds a second export's workbook in process at once, every row in it", async () => {
    // The defaults' two threads: one may hold a workbook. The second export
    // used to wait CPU_POOL_TIMEOUT_MS for it and fail with 503
    // CPU_POOL_BUSY, where before the pool all three exports ran.
    const pool = poolWith({ threads: 2, timeoutMs: 1_000 });
    const columns = [{ header: "Destinatário", key: "name" }];

    function download() {
      const raw = Object.assign(new PassThrough(), {
        setHeader: () => undefined,
        writeHead: () => undefined,
      });
      const chunks: Buffer[] = [];
      const ended = new Promise<Buffer>((resolve) =>
        raw.on("end", () => resolve(Buffer.concat(chunks))),
      );

      raw.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

      return { writer: new ExcelWriter(pool), reply: { raw } as never, ended };
    }

    const first = download();
    const second = download();

    await first.writer.start(first.reply, columns, "primeira");

    const started = Date.now();

    await second.writer.start(second.reply, columns, "segunda");
    expect(Date.now() - started).toBeLessThan(500);
    expect(pool.state()).toMatchObject({ busy: 1, waiting: 0 });

    for (let index = 0; index < 1_200; index += 1) {
      await first.writer.writeRow({ name: `Primeira ${index + 1}` });
      await second.writer.writeRow({ name: `Segunda ${index + 1}` });
    }

    await Promise.all([first.writer.end(), second.writer.end()]);

    for (const [download, name] of [
      [first, "Primeira"],
      [second, "Segunda"],
    ] as const) {
      const book = new ExcelJS.Workbook();

      await book.xlsx.load((await download.ended) as never);

      const sheet = book.getWorksheet("Relatório");

      expect(sheet?.rowCount).toBe(1 + 1_200);
      expect(sheet?.getRow(1_201).values).toEqual([, `${name} 1200`]);
    }
  }, 60_000);

  it("runs in process with no thread at all", async () => {
    const pool = poolWith({ threads: 0 });
    const xml = nfe();

    expect(pool.enabled()).toBe(false);
    expect(await parseNFeOffThread(xml, pool)).toEqual(parseNFeXml(xml));
    expect(pool.state().threads).toBe(0);
  });
});
