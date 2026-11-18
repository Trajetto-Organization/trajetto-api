import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import { generateApiKey } from "@/shared/integration/api-key-rules";

import { runHistoryWindow, unpartitionHistory } from "./support/history-window";

/**
 * A poller of /integration/v1/events through the copy window of the
 * delivery trail (plano-escala F2-17, F2-05): 0 events repeated, 0 skipped.
 *
 * The window copies delivery_event into its partitioned shell and swaps the
 * names. The feed walks one company's events by (txid, id) in commit order,
 * and its v2 cursor carries the last pair it served. Had the copy let the
 * column's DEFAULT stamp every row with the copy's own xid, every row would
 * sort after the cursor and the poller would get the whole history again;
 * a row with no txid (from before the column) would jump too. So: a poller
 * reads part of the history before the window, keeps its cursor, and after
 * the window (and a few new events) it reads exactly the rest.
 *
 * In the one-file-at-a-time phase (SERIAL_E2E_FILES): the feed serves only
 * what is below the cluster's oldest running transaction, and another
 * file's open transaction would freeze it.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "019a9a20-0000-7000-8000-00000000000a";
const SHIPPER = "019a9a20-0000-7000-8000-0000000000f1";

let deliveryId: string;
let token: string;

/** One page of the carrier's events from `cursor`. */
async function page(cursor?: string, limit = 3) {
  const query = new URLSearchParams({ limit: String(limit) });

  if (cursor) query.set("cursor", cursor);

  const response = await app.inject({
    method: "GET",
    url: `/integration/v1/events?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.json() as {
    data: Array<{ id: string; data: { note: string | null } }>;
    next_cursor: string | null;
    resume_cursor: string | null;
  };
}

/** Every page from `cursor` to the last: the notes, and where to resume. */
async function drain(cursor?: string) {
  const notes: string[] = [];
  let next = cursor;
  let resume: string | null = cursor ?? null;

  for (;;) {
    const result = await page(next);

    notes.push(...result.data.map((event) => event.data.note ?? ""));
    resume = result.resume_cursor ?? resume;

    if (!result.next_cursor) break;
    next = result.next_cursor;
  }

  return { notes, resume };
}

beforeAll(async () => {
  env.INTEGRATION_FEED_ORDER = "commit";

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da janela",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000183",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `feed-window-${randomUUID()}@example.com`,
    },
  });
  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });
  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  deliveryId = (
    await prisma.delivery.create({
      data: {
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    })
  ).id;

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração da janela",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["events:read"],
      businessId: CARRIER,
    },
  });

  token = key.token;

  // Every live process on this image: the window does not wait.
  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica: "api-feed-window",
      commit: null,
      metrics: { v: 1, capabilities: [...PROCESS_CAPABILITIES] },
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  env.INTEGRATION_FEED_ORDER = "id";
  await app?.close();
  await prisma.$disconnect();
});

describe("a poller with a v2 cursor across the copy window", () => {
  it("reads the rest of the history once, no event repeated and none skipped", async () => {
    // From before the txid column (read as 0), then the history.
    await prisma.$executeRaw`
      INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "txid")
      VALUES (${uuidV7()}, 'NOTE', 'sem-txid', ${deliveryId}, ${CARRIER}, NULL)
    `;

    const history = ["antes-1", "antes-2", "antes-3", "antes-4", "antes-5"];

    for (const note of history) {
      await prisma.deliveryEvent.create({
        data: { type: "NOTE", note, deliveryId, businessId: CARRIER },
      });
    }

    // The first page only (the poller stopped there), its next cursor kept.
    const seen: string[] = [];
    const first = await vi.waitFor(
      async () => {
        const result = await page();

        // The creation's own event, if any, comes too; the six are there.
        expect(result.next_cursor).toMatch(/^v2\./);

        return result;
      },
      { timeout: 45_000, interval: 200 },
    );

    seen.push(...first.data.map((event) => event.data.note ?? ""));

    const window = await runHistoryWindow("30-delivery-event-window.sql");

    expect(window.status, window.detail).toBe("applied");

    for (const note of ["depois-1", "depois-2"]) {
      await prisma.deliveryEvent.create({
        data: { type: "NOTE", note, deliveryId, businessId: CARRIER },
      });
    }

    const rest = await vi.waitFor(
      async () => {
        const result = await drain(first.next_cursor!);

        expect(result.notes).toEqual(
          expect.arrayContaining(["depois-1", "depois-2"]),
        );

        return result;
      },
      { timeout: 45_000, interval: 200 },
    );

    seen.push(...rest.notes);

    const expected = ["sem-txid", ...history, "depois-1", "depois-2"];

    // Each once: nothing repeated, nothing skipped.
    expect(seen.filter((note) => expected.includes(note)).sort()).toEqual(
      [...expected].sort(),
    );
    expect(new Set(seen).size).toBe(seen.length);

    // And nothing more after the last page.
    expect((await drain(rest.resume!)).notes).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    // Back to the template's plain table for whoever runs after this file.
    await unpartitionHistory("delivery_event", { hold: false });
  });
});
