import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createServer, type Server } from "node:http";
import { createGzip } from "node:zlib";
import type { AddressInfo } from "node:net";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";

import {
  signWebhookPayload,
  verifyWebhookSignature,
} from "@/shared/integration/webhook-signature";

/**
 * The dispatcher against a real database and a real HTTP receiver.
 *
 * Everything else about webhooks is testable in isolation — the signature, the
 * retry schedule, which topics match. What is NOT is the loop: claim under
 * `FOR UPDATE SKIP LOCKED`, post, read the answer, decide, and write the
 * outcome back. Each of those steps is fine on its own and the bugs live
 * between them, which is why this file exists.
 *
 * The receiver here is an actual server on an actual port. A mocked `fetch`
 * would prove we call a function; it would not prove a receiver can verify
 * what arrives, and verification failing on our own retry is the failure mode
 * that costs a customer a week.
 */
const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-00000000000a";

interface Received {
  body: string;
  headers: Record<string, string | undefined>;
  url?: string;

  /** When the request finished arriving, for tests that care about order. */
  at?: number;
}

/** How long the "/slow" endpoint takes to answer. */
const SLOW_MS = 1_500;

let server: Server;
let baseUrl: string;

let received: Received[] = [];

/** What the next request is answered with, so a test can choose the outcome. */
let reply: { status: number; body: string } = { status: 200, body: "ok" };

/**
 * The dispatcher with a permissive destination verifier.
 *
 * This file's receiver runs on `127.0.0.1`, which is exactly what the
 * destination check refuses — and it is right to. An injected verifier lets
 * the DELIVERY tests measure delivery, while the REFUSAL tests below use the
 * real verifier.
 */
const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

/** The production one, to prove that it refuses. */
const guardedDispatcher = new WebhookDispatchService();

async function seedEndpoint(options: {
  topics: string[];
  path?: string;
  secret?: string;
  is_active?: boolean;
}): Promise<{ id: string; secret: string }> {
  const secret = options.secret ?? "whsec_teste_do_despachante";

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: "Receptor de teste",
      url: `${baseUrl}${options.path ?? "/hook"}`,
      secret,
      topics: options.topics,
      businessId: CARRIER,
      is_active: options.is_active ?? true,
    },
  });

  return { id: endpoint.id, secret };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    // An endpoint that answers every event with a compression bomb: zeros,
    // gzipped on the fly, half a gigabyte once inflated.
    if (request.url === "/bomb") {
      request.resume();
      response.writeHead(500, { "Content-Encoding": "gzip" });

      const gzip = createGzip();
      gzip.pipe(response);

      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;

      const pump = () => {
        while (sent < 512 * 1024 * 1024) {
          sent += chunk.length;

          if (!gzip.write(chunk)) {
            gzip.once("drain", pump);
            return;
          }
        }

        gzip.end();
      };

      response.on("close", () => gzip.destroy());
      pump();

      return;
    }

    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers as Record<string, string | undefined>,
        url: request.url,
        at: Date.now(),
      });

      const answer = () => {
        response.writeHead(reply.status, { "Content-Type": "text/plain" });
        response.end(reply.body);
      };

      // A receiver that is alive and correct, just slow — the kind that never
      // trips the circuit breaker, because every answer is a success.
      if (request.url === "/slow") setTimeout(answer, SLOW_MS);
      else answer();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Despachante",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "despachante@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  received = [];
  reply = { status: 200, body: "ok" };

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("one event reaching one endpoint", () => {
  it("posts it, and the receiver can verify what arrived", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    const queued = await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "abc", code: "PED-1" },
    });

    expect(queued).toBe(1);

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    const signature = received[0].headers["x-trajetto-signature"];

    // The whole promise of a webhook: the receiver can tell it came from us.
    // Verified with the SAME function a customer would implement against, on
    // the exact bytes that arrived — not on a re-serialisation of them, which
    // is where this breaks in practice.
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        body: received[0].body,
        header: signature ?? "",
      }),
    ).toBe(true);

    expect(received[0].headers["x-trajetto-topic"]).toBe("delivery.delivered");
    expect(JSON.parse(received[0].body).data.delivery_id).toBe("abc");

    const row = await prisma.webhookDelivery.findFirst({
      where: { businessId: CARRIER },
    });

    expect(row?.status).toBe("DELIVERED");
    expect(row?.response_status).toBe(200);
    expect(row?.latency_ms).not.toBeNull();
  });

  it("refuses a signature checked against the wrong secret", async () => {
    // The other half of the pair. Without it the check above would pass for a
    // verifier that returns true for anything.
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "abc" },
    });

    await dispatcher.processBatch();

    expect(
      verifyWebhookSignature({
        secret: "whsec_de_outra_empresa",
        body: received[0].body,
        header: received[0].headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(false);
  });
});

describe("who gets an event", () => {
  it("skips an endpoint that did not subscribe to the topic", async () => {
    await seedEndpoint({ topics: ["route.started"] });

    const queued = await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    expect(queued).toBe(0);

    await dispatcher.processBatch();

    expect(received).toHaveLength(0);
  });

  it("matches a one-level wildcard", async () => {
    await seedEndpoint({ topics: ["delivery.*"] });

    expect(
      await fanOutWebhookEvent({
        topic: "delivery.cancelled",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(1);

    // And only its own family: `delivery.*` is not a subscription to routes.
    expect(
      await fanOutWebhookEvent({
        topic: "route.started",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(0);
  });

  it("skips an endpoint the customer paused", async () => {
    await seedEndpoint({ topics: ["delivery.*"], is_active: false });

    expect(
      await fanOutWebhookEvent({
        topic: "delivery.delivered",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(0);
  });

  it("gives each subscribed endpoint its own row", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"], path: "/um" });
    await seedEndpoint({ topics: ["delivery.*"], path: "/dois" });

    expect(
      await fanOutWebhookEvent({
        topic: "delivery.delivered",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(2);

    await dispatcher.processBatch();

    // One failing receiver must not cost the other its event, which is only
    // true because they are separate rows with separate outcomes.
    expect(received).toHaveLength(2);
  });
});

describe("when the receiver does not cooperate", () => {
  it("schedules a retry after a 500 and keeps the body it answered with", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 500, body: "banco de dados indisponível" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);

    // The reason, kept. It is the first thing a customer's engineer is shown,
    // and asking them to reproduce it is asking them to wait for it to happen
    // again.
    expect(row.response_status).toBe(500);
    expect(row.response_body).toContain("banco de dados indisponível");

    // Not immediately: a receiver that is down stays down for a while, and a
    // tight loop against it is an outage we are adding to.
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("stops for good on 410 Gone", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 410, body: "não envie mais" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    // A receiver saying "stop sending me this" is the difference between an
    // integration and a nuisance.
    expect(row.status).toBe("FAILED");

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);
  });

  it("counts failures in a row on the endpoint, and resets on a success", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 503, body: "indisponível" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const afterFailure = await prisma.webhookEndpoint.findFirstOrThrow({
      where: { id: endpoint.id },
    });

    expect(afterFailure.consecutive_failures).toBeGreaterThan(0);

    reply = { status: 200, body: "ok" };

    // A second event, delivered. The counter has to be about a run of
    // failures and not a total — an endpoint that fails once a month would
    // otherwise be switched off eventually for no reason.
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER, status: "PENDING" },
      data: { availableAt: new Date() },
    });

    await dispatcher.processBatch();

    const afterSuccess = await prisma.webhookEndpoint.findFirstOrThrow({
      where: { id: endpoint.id },
    });

    expect(afterSuccess.consecutive_failures).toBe(0);
  });
});

describe("claiming work", () => {
  it("leaves a row scheduled for later alone", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: { availableAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    expect(await dispatcher.processBatch()).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("reclaims a row whose lease expired", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // A replica that died mid-send: PROCESSING, with a lease that has run
    // out. Nobody is coming back for it, so somebody else has to.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    expect(await dispatcher.processBatch()).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("does not touch a row whose lease is still running", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // Somebody else is sending this right now. Claiming it here is how a
    // receiver gets the same event twice from two replicas.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() + 60 * 1000),
      },
    });

    expect(await dispatcher.processBatch()).toBe(0);
    expect(received).toHaveLength(0);
  });
});

describe("an endpoint built to hurt the dispatcher", () => {
  it("keeps only the first kilobyte of a compression bomb, in bounded memory", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"], path: "/bomb" });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    const before = process.memoryUsage();

    // Before: the whole inflated answer was read into one string, inside the
    // API process that also serves HTTP, sockets and every other worker.
    expect(await dispatcher.processBatch()).toBe(1);

    const after = process.memoryUsage();
    const grew =
      after.heapUsed +
      after.arrayBuffers -
      (before.heapUsed + before.arrayBuffers);

    expect(grew).toBeLessThan(96 * 1024 * 1024);

    const [row] = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
    });

    expect(row.status).toBe("PENDING");
    expect(row.response_status).toBe(500);
    expect((row.response_body ?? "").length).toBeLessThanOrEqual(1024 + 20);
  }, 60_000);

  it("records a success whose body carries a NUL byte, instead of sending it again", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    // Postgres refuses NUL in text. The update recording this 200 used to
    // throw, the failure path took over, and the event went out a second time.
    reply = { status: 200, body: "ok\u0000" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const [row] = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
    });

    expect(row.status).toBe("DELIVERED");
    expect(row.response_body).toBe("ok");
  });

  it("closes, instead of reclaiming, a row whose last allowed attempt died with the process", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // What a replica killed mid-send leaves behind — here on its sixth and
    // last attempt. Reclaimed at every lease expiry, a row that kills its
    // worker takes every replica down in turn.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        status: "PROCESSING",
        attempts: 6,
        leaseExpiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    expect(await dispatcher.processBatch()).toBe(0);
    expect(received).toHaveLength(0);

    const [row] = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
    });

    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/interrompido/);
  });
});

describe("the signature on each attempt", () => {
  it("is fresh enough for the receiver to accept, however late the attempt", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { atrasado: true },
    });

    // The row waited an hour — a retry schedule, a queue backlog, a manual
    // resend next day. The signature stored at fan-out is now an hour old.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        signature: signWebhookPayload(
          endpoint.secret,
          "{}",
          new Date(Date.now() - 60 * 60 * 1000),
        ).header,
      },
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    // Checked exactly as our documentation tells a receiver to: a signature
    // older than five minutes is refused. It used to be resent unchanged.
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        body: received[0].body,
        header: received[0].headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(true);
  });
});

describe("a destination that cannot be resolved right now", () => {
  it("is retried, and the endpoint stays on", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // A DNS timeout. It used to be refused like a private address: the event
    // failed for good and the endpoint was switched off, silently ending the
    // customer's integration over one resolver blip.
    const blip = new WebhookDispatchService(async () => ({
      allowed: false,
      transient: true,
      reason: "Não foi possível resolver o endereço do endpoint.",
    }));

    await blip.processBatch();

    const [row] = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
    });

    expect(row.status).toBe("PENDING");

    const after = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });

    expect(after.disabled_at).toBeNull();
  });
});

describe("a retry sends the same bytes", () => {
  it("posts a body the first signature still covers", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 500, body: "tente de novo" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "abc", city: "São Paulo" },
    });

    await dispatcher.processBatch();

    reply = { status: 200, body: "ok" };

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: { availableAt: new Date() },
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(2);

    // Byte-identical body: re-serialising at send time would produce a body
    // a receiver cannot match to the first — an accented character written
    // differently is enough to break it.
    expect(received[1].body).toBe(received[0].body);

    // The signature is made at each send, with that send's timestamp (`t=`,
    // the receiver's replay window), so the header is NOT compared byte for
    // byte: two sends a second apart differ there, and the old equality
    // failed whenever they straddled a second. Each must verify over the
    // same body, and time only moves forward.
    for (const delivery of received) {
      expect(
        verifyWebhookSignature({
          secret: endpoint.secret,
          body: delivery.body,
          header: delivery.headers["x-trajetto-signature"] ?? "",
        }),
      ).toBe(true);
    }

    const timestampOf = (header: string | undefined) =>
      Number(/(?:^|,)t=(\d+)/.exec(header ?? "")?.[1]);

    expect(
      timestampOf(received[1].headers["x-trajetto-signature"]),
    ).toBeGreaterThanOrEqual(
      timestampOf(received[0].headers["x-trajetto-signature"]),
    );
  });
});

describe("where a webhook does NOT go", () => {
  it("refuses an internal address instead of fetching it", async () => {
    // O ataque inteiro em três linhas: o cliente cadastra o endereço de
    // the cloud metadata, we fetch it, and the monitor hands them the body.
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Metadados",
        url: "https://169.254.169.254/latest/meta-data/",
        secret: "whsec_teste",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
        is_active: true,
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await guardedDispatcher.processBatch();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });

    expect(row.status).toBe("FAILED");

    // And nothing was fetched: this file's local receiver got nothing, and
    // the response body stayed empty — which is what keeps the monitor from
    // becoming a reader of the internal network.
    expect(received).toHaveLength(0);
    expect(row.response_body ?? "").toBe("");

    // Permanent: repeating the sweep must not become a probe in a loop.
    await guardedDispatcher.processBatch();

    expect(received).toHaveLength(0);
  });

  it("refuses localhost by name", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Interno",
        url: "https://localhost:9200/_cat/indices",
        secret: "whsec_teste",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
        is_active: true,
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await guardedDispatcher.processBatch();

    expect(received).toHaveLength(0);

    /**
     * Refused by the GUARD, not by the network. Nothing listens on 9200 here,
     * so a dispatcher with no guard at all also receives nothing — it gets
     * ECONNREFUSED and schedules a retry. `received` alone passed with the
     * guard deleted; the row says which of the two happened.
     */
    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });

    expect(row.status).toBe("FAILED");
    expect(row.lastError ?? "").not.toMatch(
      /ECONNREFUSED|fetch failed|connect/i,
    );

    // A permanent refusal switches the endpoint off, so the next sweep does
    // not try the same internal address again.
    expect(
      (
        await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: endpoint.id },
        })
      ).disabled_at,
    ).not.toBeNull();
  });

  it("does not let the customer overwrite the signature", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    // The map is written straight in, as a row predating the schema rule
    // would be: the second lock is the spread order in the dispatcher.
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        headers: {
          "X-Trajetto-Signature": "t=1,v1=forjada",
          "X-Api-Key": "a-do-cliente",
        },
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    // Our signature, not theirs — and it verifies.
    expect(received[0].headers["x-trajetto-signature"]).not.toBe(
      "t=1,v1=forjada",
    );

    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        body: received[0].body,
        header: received[0].headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(true);

    // E o que é dele passa.
    expect(received[0].headers["x-api-key"]).toBe("a-do-cliente");
  });
});

describe("a backlog, and a slow neighbour", () => {
  /**
   * The dispatcher took twenty rows every five seconds and sent them in waves
   * of five, each wave as slow as its slowest row. So a backlog drained at a
   * fixed trickle whatever the receivers could take, and one tenant's slow
   * endpoint set the pace for every other tenant's webhooks.
   */
  it("drains a backlog in one sweep, not twenty rows every five seconds", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    for (let index = 0; index < 60; index += 1) {
      await fanOutWebhookEvent({
        topic: "delivery.delivered",
        businessId: CARRIER,
        payload: { index },
      });
    }

    expect(await dispatcher.processBatch()).toBe(60);
    expect(received).toHaveLength(60);
  }, 60_000);

  it("does not make everybody wait for a slow endpoint", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"], path: "/slow" });
    await seedEndpoint({ topics: ["delivery.failed"] });

    for (let index = 0; index < 8; index += 1) {
      await fanOutWebhookEvent({
        topic: "delivery.delivered",
        businessId: CARRIER,
        payload: { index },
      });
    }

    for (let index = 0; index < 10; index += 1) {
      await fanOutWebhookEvent({
        topic: "delivery.failed",
        businessId: CARRIER,
        payload: { index },
      });
    }

    // The slow endpoint's rows are the oldest, so they are claimed first.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER, topic: "delivery.delivered" },
      data: { availableAt: new Date(Date.now() - 60 * 1000) },
    });

    const started = Date.now();

    await dispatcher.processBatch();

    const fast = received.filter((entry) => entry.url === "/hook");
    const slowest = Math.max(...fast.map((entry) => (entry.at ?? 0) - started));

    expect(fast).toHaveLength(10);
    expect(
      slowest,
      `o último webhook rápido esperou ${slowest} ms pelo vizinho lento`,
    ).toBeLessThan(SLOW_MS);
  }, 60_000);
});
