import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@prisma/client";
import dnsCallbacks from "node:dns";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * DNS rebinding, end to end, through the PRODUCTION dispatcher.
 *
 * The destination check resolved the name and saw a public address; the fetch
 * then resolved the same name again, on its own, and connected wherever the
 * second answer pointed. An attacker's name with TTL 0 answers 93.184.216.34
 * to the first question and 127.0.0.1 (or 10.0.1.5) to the second: the TLS
 * handshake fails, but the time it took — and the error — maps the ports of
 * the internal network through the monitor.
 *
 * Both resolutions are stubbed as that name would answer:
 * - `node:dns/promises` (what our code imports) answers public, then private;
 * - `node:dns` `lookup` (what Node's socket uses when nobody gives it one)
 *   answers private, as the attacker's server does by the time it is asked.
 * A TCP server on 127.0.0.1 counts the connections that reach it.
 */
const resolution = vi.hoisted(() => {
  const PUBLIC = "93.184.216.34";
  const PRIVATE = "127.0.0.1";

  const asked = new Map<string, number>();

  const answer = (host: string): string => {
    const count = (asked.get(host) ?? 0) + 1;

    asked.set(host, count);

    return count === 1 ? PUBLIC : PRIVATE;
  };

  class Resolver {
    resolve4 = async (host: string) => [answer(host)];
    resolve6 = async () => {
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    };
    setServers() {}
    cancel() {}
  }

  const lookup = async (host: string) => [{ address: answer(host), family: 4 }];

  return { PUBLIC, PRIVATE, asked, Resolver, lookup };
});

vi.mock("node:dns/promises", () => ({
  default: { lookup: resolution.lookup, Resolver: resolution.Resolver },
  lookup: resolution.lookup,
  Resolver: resolution.Resolver,
}));

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";

const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000000d9";

let server: Server;
let port = 0;
let connections = 0;

const originalLookup = dnsCallbacks.lookup;

beforeAll(async () => {
  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  port = (server.address() as AddressInfo).port;

  // What the socket's own resolution sees for the attacker's name.
  (dnsCallbacks as { lookup: unknown }).lookup = (
    hostname: string,
    options: unknown,
    callback?: unknown,
  ) => {
    const done = (typeof options === "function" ? options : callback) as (
      ...args: unknown[]
    ) => void;
    const opts = (typeof options === "object" && options) || {};

    if (hostname !== "rebind.exemplo.com.br") {
      return (originalLookup as (...args: unknown[]) => void)(
        hostname,
        options,
        callback,
      );
    }

    if ((opts as { all?: boolean }).all) {
      return done(null, [{ address: resolution.PRIVATE, family: 4 }]);
    }

    return done(null, resolution.PRIVATE, 4);
  };

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Rebinding",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000199",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "rebinding@exemplo.com.br",
    },
  });
}, 90_000);

afterEach(async () => {
  resolution.asked.clear();
  connections = 0;

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  (dnsCallbacks as { lookup: unknown }).lookup = originalLookup;

  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a name that changes its answer between the check and the connection", () => {
  it("never gets a connection to the private address", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Rebinding",
        url: `https://rebind.exemplo.com.br:${port}/hook`,
        secret: "whsec_teste_do_rebinding",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // The production dispatcher: the real destination check, the real
    // connection.
    await new WebhookDispatchService().processBatch();

    expect(
      connections,
      "o fetch resolveu o nome sozinho e conectou no endereço privado",
    ).toBe(0);

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });

    // Refused for good, and the monitor shows neither the address nor a
    // latency that would time the internal network.
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBe(
      "O endpoint precisa ser um endereço alcançável pela internet.",
    );
    expect(row.lastError).not.toContain(resolution.PRIVATE);
    expect(row.latency_ms).toBeNull();
  }, 30_000);
});
