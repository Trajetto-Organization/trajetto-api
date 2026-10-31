import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { socketClientEntry } from "./support/socket-client";
import { waitForRoom, waitUntil } from "./support/socket-waits";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * `catalogChanged` reaches the MASTER's /admin tabs (decision 2.3, REV-22).
 *
 * The hint went out only to `business:<id>`, a room a MASTER never joins —
 * they have no company of their own — so an /admin screen kept offering a
 * deactivated shipper or a renamed part until someone pressed Revalidar. The
 * MASTER sockets hear every company's hint (the web keeps the ones of the
 * company it shows); another company's staff still hears nothing.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe7c0-0000-7000-8000-00000000000a";
const OTHER = "018fe7c0-0000-7000-8000-00000000000b";
const MASTER = "018fe7c0-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018fe7c0-0000-7000-8000-0000000000b1";

let server: Server;
let port = 0;

let io: typeof import("@/websocket");
let ioServer: Awaited<
  ReturnType<typeof import("@/websocket").initializeSocketIO>
>;

type Client = {
  id: string;
  on: Function;
  off: Function;
  disconnect: () => void;
};

const clients: Client[] = [];

async function sessionToken(
  userId: string,
  role: string,
  businessId: string | null,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

async function connect(token: string): Promise<Client> {
  const { io: connectTo } = await import(
    /* @vite-ignore */ socketClientEntry()
  );

  const socket: Client = await new Promise((resolve, reject) => {
    const client = connectTo(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

    client.on("connect", () => {
      clearTimeout(timer);
      resolve(client);
    });

    client.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  clients.push(socket);

  return socket;
}

/** Every catalogChanged the socket hears within the window. */
function heard(client: Client, windowMs = 1500): Promise<unknown[]> {
  const received: unknown[] = [];
  const listener = (payload: unknown) => received.push(payload);

  client.on("catalogChanged", listener);

  return new Promise((resolve) =>
    setTimeout(() => {
      client.off("catalogChanged", listener);
      resolve(received);
    }, windowMs),
  );
}

const company = (id: string, cnpj: string) => ({
  id,
  corporate_reason: `Transportadora ${cnpj}`,
  cep: "01001000",
  city: "São Paulo",
  uf: "SP",
  street: "Rua",
  address_number: "1",
  cnpj,
  cnae: "4930202",
  responsible_name: "Responsável",
  telephone: "11999999999",
  email: `catalogo-${randomUUID()}@exemplo.com.br`,
});

let masterClient: Client;
let otherClient: Client;

beforeAll(async () => {
  await prisma.business.createMany({
    data: [
      company(CARRIER, "77222888000101"),
      company(OTHER, "77222888000202"),
    ],
  });

  await prisma.user.createMany({
    data: [
      {
        id: MASTER,
        name: "Suporte",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: OTHER_ADMIN,
        name: "Admin da outra",
        email: `outra-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: OTHER,
      },
    ],
  });

  server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  ioServer = await io.initializeSocketIO(server);

  masterClient = await connect(await sessionToken(MASTER, "MASTER", null));
  otherClient = await connect(
    await sessionToken(OTHER_ADMIN, "BUSINESS_ADMIN", OTHER),
  );

  // The rooms the event goes to (the masters') and the one it must not
  // (the other company's), as the server records them — not 1 s later.
  await waitForRoom(ioServer, masterClient.id, "masters", true);
  await waitForRoom(ioServer, otherClient.id, `business:${OTHER}`, true);
}, 120_000);

afterAll(async () => {
  for (const client of clients) client.disconnect();

  await io?.shutdownSocketIO();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  await prisma.$disconnect();
});

describe("catalogChanged and the MASTER", () => {
  it("reaches a MASTER socket, which belongs to no company", async () => {
    const received: unknown[] = [];
    const listener = (payload: unknown) => received.push(payload);

    masterClient.on("catalogChanged", listener);

    try {
      io.sendCatalogChangedEvent(CARRIER, "shipper");

      // The first copy however long it takes, then a window for a second.
      await waitUntil(() => received.length > 0, "o MASTER ouvir o evento");
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      masterClient.off("catalogChanged", listener);
    }

    expect(received).toEqual([{ businessId: CARRIER, entity: "shipper" }]);
  });

  it("still does not reach another company's staff", async () => {
    const other = heard(otherClient);

    io.sendCatalogChangedEvent(CARRIER, "part");

    expect(await other).toEqual([]);
  });
});
