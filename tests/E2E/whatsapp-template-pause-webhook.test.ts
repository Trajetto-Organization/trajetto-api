import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server } from "socket.io";
import { container } from "tsyringe";

import { env } from "@/env";
import { MetaCloudApiProvider } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";
import { socketAdapterOptions } from "@/shared/socket/adapter-redis";

/**
 * Meta says a template is paused — and the lane stops before a send is
 * refused (OUTBOX-07 d, OUTBOX-16).
 *
 * The status webhook received `message_template_status_update` and only
 * logged it. The provider's pause was learned from a send Meta refused
 * (132015), one refusal per replica on an account whose quality rating every
 * tenant shares, and nothing lifted it early when Meta reinstated the
 * template. Here the callback is signed like Meta signs it, lands on this
 * replica, and must reach the provider of this replica AND of another one
 * listening on the same Redis adapter.
 */
const APP_SECRET = "segredo-do-app-de-teste";
const TEMPLATE = "trajetto_notification";

/** The adapter event the replicas announce lane changes on. */
const LANE_EVENT = "trajetto:whatsapp-template-lane";

const saved = {
  secret: env.META_WHATSAPP_APP_SECRET,
  token: env.META_WHATSAPP_ACCESS_TOKEN,
  phone: env.META_WHATSAPP_PHONE_NUMBER_ID,
  template: env.META_WHATSAPP_TEMPLATE_NAME,
  customerTemplate: env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME,
  adapterKey: env.SOCKET_ADAPTER_KEY,
};

let app: Awaited<typeof import("@/http")>["app"];
let websocket: typeof import("@/websocket");
let httpServer: HttpServer;

let provider: MetaCloudApiProvider;

/** A second replica on the same adapter: what it heard. */
const otherReplica = {
  io: null as Server | null,
  pub: null as Redis | null,
  sub: null as Redis | null,
  heard: [] as unknown[],
};

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function templateCallback(value: Record<string, unknown>): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "message_template_status_update",
            value: {
              message_template_id: 1234567890,
              message_template_name: TEMPLATE,
              message_template_language: "pt_BR",
              reason: null,
              ...value,
            },
          },
        ],
      },
    ],
  });
}

function postCallback(body: string, signature = sign(body)) {
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    payload: body,
  });
}

function stubFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ messages: [{ id: `wamid.${randomUUID()}` }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

const send = () =>
  provider.sendMessage({
    phoneNumber: "11999990000",
    message: "Sua entrega saiu.",
  });

/**
 * Whether the other replica heard `change`. By content, not position: a frame
 * a previous test published can still be on its way when the next one runs.
 */
function heard(change: unknown): boolean {
  return otherReplica.heard.some(
    (entry) => JSON.stringify(entry) === JSON.stringify(change),
  );
}

/**
 * Polls `check` until it holds, up to `ms`. Every use is something that must
 * happen (a frame crossing Redis, a pause taking effect), so the deadline is
 * generous: 2 s was a guess a loaded runner could miss, and the poll returns
 * as soon as the answer is there.
 */
async function eventually(
  check: () => boolean | Promise<boolean>,
  ms = 15_000,
) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }

  return check();
}

beforeAll(async () => {
  env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  env.META_WHATSAPP_ACCESS_TOKEN = "token-de-teste";
  env.META_WHATSAPP_PHONE_NUMBER_ID = "1234567890";
  env.META_WHATSAPP_TEMPLATE_NAME = TEMPLATE;
  env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = undefined;

  // A channel prefix of this file's own: E2E files run in parallel on one
  // Redis, and Pub/Sub ignores the database number.
  env.SOCKET_ADAPTER_KEY = `socket.io-lane-${randomUUID()}`;

  ({ app } = await import("@/http"));
  await app.ready();

  // The real provider, so the pause it keeps is the one under test.
  provider = new MetaCloudApiProvider();
  container.registerInstance("WhatsAppProvider", provider);

  // This replica's realtime, with the production adapter.
  httpServer = createServer();
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));

  websocket = await import("@/websocket");
  await websocket.initializeSocketIO(httpServer);

  // Another replica of the cluster: same Redis, same prefix.
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  otherReplica.pub = new Redis(url, { maxRetriesPerRequest: 1 });
  otherReplica.sub = new Redis(url, { maxRetriesPerRequest: 1 });

  otherReplica.io = new Server({
    adapter: createAdapter(
      otherReplica.pub,
      otherReplica.sub,
      socketAdapterOptions(env),
    ),
  });

  otherReplica.io.on(LANE_EVENT, (change: unknown) => {
    otherReplica.heard.push(change);
  });

  // The adapters subscribe on construction, asynchronously. A server-side
  // emit travels on the request channel: until Redis counts both nodes on
  // it, rather than 500 ms for the round trip.
  const requestChannel = `${socketAdapterOptions(env).key}-request#/#`;

  expect(
    await eventually(async () => {
      const [, subscribers] = (await otherReplica.pub!.pubsub(
        "NUMSUB",
        requestChannel,
      )) as [string, number | string];

      return Number(subscribers) >= 2;
    }, 15_000),
    "os dois nós não assinaram o canal de pedidos do adapter",
  ).toBe(true);
}, 120_000);

beforeEach(() => {
  provider.resumeTemplate(TEMPLATE);
  otherReplica.heard = [];

  vi.unstubAllGlobals();
});

afterAll(async () => {
  env.META_WHATSAPP_APP_SECRET = saved.secret;
  env.META_WHATSAPP_ACCESS_TOKEN = saved.token;
  env.META_WHATSAPP_PHONE_NUMBER_ID = saved.phone;
  env.META_WHATSAPP_TEMPLATE_NAME = saved.template;
  env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = saved.customerTemplate;
  env.SOCKET_ADAPTER_KEY = saved.adapterKey;

  vi.unstubAllGlobals();

  await (
    otherReplica.io?.of("/").adapter as { close?: () => unknown } | undefined
  )?.close?.();
  await otherReplica.pub?.quit();
  await otherReplica.sub?.quit();

  websocket?.closeRealtimeConnections();
  await websocket?.shutdownSocketIO();
  await new Promise((done) => httpServer?.close(() => done(undefined)));

  await app?.close();
}, 60_000);

describe("a signed PAUSED callback", () => {
  it("stops the template's sends on this replica before Meta refuses one", async () => {
    const response = await postCallback(
      templateCallback({
        event: "PAUSED",
        other_info: {
          title: "FIRST_PAUSE",
          description: "Your message template has been paused for 3 hours.",
        },
      }),
    );

    expect(response.statusCode).toBe(200);

    const fetchMock = stubFetch();
    const result = await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      retryable: true,
      errorCode: 132015,
    });

    // As long as Meta said, not the hour a refused send would have guessed.
    expect(result.retryAfterSeconds).toBeGreaterThan(3 * 3600 - 5);
  });

  it("tells the other replicas, through the adapter", async () => {
    await postCallback(
      templateCallback({
        event: "PAUSED",
        other_info: { title: "SECOND_PAUSE" },
      }),
    );

    // Counted from the entry's time (a whole second), so a second or two may
    // already be gone.
    expect(
      await eventually(() =>
        otherReplica.heard.some((entry) => {
          const change = entry as {
            template?: string;
            action?: string;
            seconds?: number;
          };

          return (
            change.template === TEMPLATE &&
            change.action === "pause" &&
            (change.seconds ?? 0) > 6 * 3600 - 5 &&
            (change.seconds ?? 0) <= 6 * 3600
          );
        }),
      ),
      JSON.stringify(otherReplica.heard),
    ).toBe(true);
  });
});

describe("a signed REINSTATED callback", () => {
  it("lets the backlog go as soon as Meta lifts the pause", async () => {
    await postCallback(templateCallback({ event: "PAUSED" }));

    const response = await postCallback(
      templateCallback({
        event: "REINSTATED",
        other_info: { title: "UNPAUSE" },
      }),
    );

    expect(response.statusCode).toBe(200);

    const fetchMock = stubFetch();
    const result = await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);

    expect(
      await eventually(() => heard({ template: TEMPLATE, action: "resume" })),
      JSON.stringify(otherReplica.heard),
    ).toBe(true);
  });
});

describe("what another replica announces", () => {
  it("pauses and resumes this replica's provider", async () => {
    const fetchMock = stubFetch();

    otherReplica.io!.serverSideEmit(LANE_EVENT, {
      template: TEMPLATE,
      action: "pause",
      seconds: 3600,
    });

    expect(
      await eventually(async () => {
        const result = await send();
        return result.errorCode === 132015;
      }),
    ).toBe(true);

    const callsWhilePaused = fetchMock.mock.calls.length;

    otherReplica.io!.serverSideEmit(LANE_EVENT, {
      template: TEMPLATE,
      action: "resume",
    });

    expect(await eventually(async () => (await send()).success === true)).toBe(
      true,
    );

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhilePaused);
  });
});

describe("what does not touch the lane", () => {
  it("a callback that is not Meta's signature", async () => {
    const body = templateCallback({ event: "PAUSED" });

    const response = await postCallback(body, sign(body, "outro-segredo"));

    expect(response.statusCode).toBe(401);

    const fetchMock = stubFetch();
    expect((await send()).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(otherReplica.heard).toEqual([]);
  });

  it("the same name paused in another language — another template", async () => {
    await postCallback(
      templateCallback({ event: "PAUSED", message_template_language: "en_US" }),
    );

    const fetchMock = stubFetch();
    expect((await send()).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
