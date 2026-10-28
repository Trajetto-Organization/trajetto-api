import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";
import { resetOperationalMetricsCache } from "@/shared/health/operational-metrics";

/**
 * The numbers a MASTER uses to decide when to add capacity.
 *
 * The screen shows connection usage against `max_connections`, outbox depth
 * and lag, the AI backlog, per-channel delivery outcomes and queue-table
 * bloat — and every one of them is a badge that turns red at a threshold.
 * Nothing tested any of it. A panel of numbers is the easiest thing in a
 * product to get wrong and the hardest to notice: a percentage computed the
 * wrong way round, a lag measured from the wrong column, a channel's failures
 * landing in another channel's row all look exactly like a healthy system
 * until the day they are the reason nobody was warned.
 *
 * So this seeds a KNOWN state and checks the answer against it. "A number came
 * back" is not the assertion; "this number is that number" is.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const MASTER = "018fd900-0000-7000-8000-0000000000m1";
const CARRIER = "018fd900-0000-7000-8000-00000000000a";
const STAFF = "018fd900-0000-7000-8000-0000000000s1";

let masterToken = "";
let staffToken = "";

/** A session the middleware will accept: a refresh family has to exist. */
async function tokenFor(
  userId: string,
  role: string,
  businessId: string | null = null,
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

  /*
    The claims a real access token carries, not only the session ones. The
    tenant guard reads `businessId` off the token and compares it with the row
    it loaded; a token without it is refused as a session that does not add up
    — 401 — and the role check never runs, so a test written against 403 would
    be reporting the wrong refusal.
  */
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

/** Seconds of lag the seeded outbox event should report. */
const OLDEST_AGE_SECONDS = 600;

/**
 * An outbox row of this test's own.
 *
 * `eventKey` is unique and the aggregate columns are required — the table is
 * the product's queue, not a scratch pad, and a fixture that omits them fails
 * at the database rather than at the assertion.
 */
function probe(overrides: Record<string, unknown>) {
  return {
    id: randomUUID(),
    eventKey: `metrics-probe-${randomUUID()}`,
    topic: "metrics.probe",
    aggregateType: "metrics",
    aggregateId: randomUUID(),
    businessId: CARRIER,
    payload: {},
    availableAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Métricas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(51000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `metrics-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: MASTER,
        name: "Master das Métricas",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: STAFF,
        name: "Gestora da Transportadora",
        email: `staff-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
    ],
  });

  masterToken = await tokenFor(MASTER, "MASTER");
  staffToken = await tokenFor(STAFF, "BUSINESS_ADMIN", CARRIER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: CARRIER },
  });

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [MASTER, STAFF] } },
  });

  await prisma.user.deleteMany({ where: { id: { in: [MASTER, STAFF] } } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

function metrics(token: string) {
  // The route serves a 10-second snapshot; these tests read before and
  // after writing, milliseconds apart, and must see the write.
  resetOperationalMetricsCache();

  return app.inject({
    method: "GET",
    url: "/health/metrics",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("who may read the infrastructure's posture", () => {
  it("refuses a company administrator", async () => {
    /**
     * Not tenant data, and that is exactly why it is MASTER-only: connection
     * ceilings, queue depths and dead-tuple ratios describe the SHARED
     * infrastructure, and one customer's administrator has no business
     * learning how close their neighbours are to filling it.
     */
    const response = await metrics(staffToken);

    /*
      403 and not 401, and the difference is not pedantry: both clients read a
      401 as a session that is over. The app logs the driver out on any of
      them, and the web's session check treats it as expired — so a company
      administrator who opened this screen used to be signed out of the product
      instead of being told no.
    */
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTH_ROLE_FORBIDDEN");
  });

  it("refuses an anonymous caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/metrics",
    });

    // 401, not 403: there is nobody to refuse yet. The distinction matters to
    // a client deciding whether to refresh a token or to give up.
    expect(response.statusCode).toBe(401);
  });
});

describe("the database numbers", () => {
  it("are read from Postgres, not made up", async () => {
    const body = (await metrics(masterToken)).json();

    const [{ max_connections: configured }] = await prisma.$queryRaw<
      { max_connections: string }[]
    >`SELECT current_setting('max_connections') AS max_connections`;

    /**
     * The same setting the server is running with.
     *
     * The test container is deliberately NOT on the Postgres default: a
     * hard-coded 100 is the most plausible wrong answer there is, and against
     * a default installation it is also the right one — the assertion would
     * pass over a constant. It does not any more.
     */
    expect(body.database.max_connections).toBe(Number(configured));

    expect(
      Number(configured),
      "o Postgres de teste voltou ao padrão; a asserção acima deixa de distinguir um valor fixo",
    ).not.toBe(100);

    expect(body.database.active_connections).toBeGreaterThan(0);
  });

  it("and the percentage is usage, not headroom", async () => {
    /**
     * The easiest number in the panel to invert, and the badge reads
     * "Crítico" above 90. Inverted, an idle database shows red and a database
     * about to refuse connections shows green — and nobody double-checks a
     * green.
     */
    const body = (await metrics(masterToken)).json();

    const { active_connections: active, max_connections: max } = body.database;

    expect(body.database.connection_usage_percent).toBe(
      Math.round((active / max) * 100),
    );

    // On a test machine the pool is a handful of connections against a ceiling
    // of a hundred, so usage is low. Asserting that directly is what catches
    // the inversion: headroom would be ~95.
    expect(body.database.connection_usage_percent).toBeLessThan(50);
  });
});

describe("the outbox numbers", () => {
  it("count what is really pending and failed", async () => {
    const before = (await metrics(masterToken)).json().outbox;

    await prisma.domainOutboxEvent.createMany({
      data: [probe({ status: "PENDING" }), probe({ status: "FAILED" })],
    });

    const after = (await metrics(masterToken)).json().outbox;

    expect(after.pending).toBe(before.pending + 1);
    expect(after.failed).toBe(before.failed + 1);
  });

  it("and the lag is measured from the oldest one waiting", async () => {
    /**
     * Two lags, and the reason the second exists is the interesting half.
     *
     * `eligible_seconds` only looks at events already DUE, which is the
     * classic "is the worker keeping up?" number and is blind by
     * construction: an event pushed into backoff gets a future `availableAt`,
     * so a queue in a full retry storm reports no lag at all — exactly when
     * things are burning. `any_seconds` measures from creation and answers
     * the honest question.
     */
    const createdAt = new Date(Date.now() - OLDEST_AGE_SECONDS * 1000);

    await prisma.domainOutboxEvent.create({
      // Due ten minutes ago: eligible, and the oldest of anything pending.
      data: probe({
        status: "PENDING",
        availableAt: createdAt,
        created_at: createdAt,
      }),
    });

    const outbox = (await metrics(masterToken)).json().outbox;

    // Within a few seconds of the seeded age — the query rounds through
    // Postgres' clock, not the test's.
    expect(outbox.eligible ?? outbox.oldest_pending_seconds).toBeGreaterThan(
      OLDEST_AGE_SECONDS - 60,
    );

    expect(outbox.oldest_pending_seconds).toBeLessThan(
      OLDEST_AGE_SECONDS + 120,
    );

    expect(outbox.oldest_pending_any_seconds).toBeGreaterThanOrEqual(
      outbox.oldest_pending_seconds,
    );
  });

  it("and a queue in backoff still reports a lag somebody can see", async () => {
    /**
     * The blindness, demonstrated. An event created ten minutes ago and pushed
     * an hour into the future is invisible to `eligible_seconds` — and it is
     * precisely the shape of a retry storm.
     */
    await prisma.domainOutboxEvent.deleteMany({
      where: { businessId: CARRIER },
    });

    const createdAt = new Date(Date.now() - OLDEST_AGE_SECONDS * 1000);

    await prisma.domainOutboxEvent.create({
      data: probe({
        status: "PENDING",
        availableAt: new Date(Date.now() + 60 * 60 * 1000),
        created_at: createdAt,
      }),
    });

    const outbox = (await metrics(masterToken)).json().outbox;

    expect(
      outbox.oldest_pending_any_seconds,
      "a fila em backoff não aparece em lugar nenhum",
    ).toBeGreaterThan(OLDEST_AGE_SECONDS - 60);
  });
});

describe("the notification counters", () => {
  it("emit every channel, even the ones at zero", async () => {
    /**
     * A dashboard that has to cope with a missing key ends up with `?? 0`
     * scattered through it, and then a channel that stops reporting looks
     * exactly like a channel with nothing to report.
     */
    const body = (await metrics(masterToken)).json();

    const channels = body.notifications.channels.map(
      (entry: { channel: string }) => entry.channel,
    );

    for (const channel of ["IN_APP", "EMAIL", "PUSH", "WHATSAPP"]) {
      expect(channels, `canal ausente: ${channel}`).toContain(channel);
    }

    expect(body.notifications.window_hours).toBeGreaterThan(0);
  });

  it("and the total agrees with the per-channel rows", async () => {
    // Two numbers on the same screen that disagree teach people to believe
    // neither.
    const body = (await metrics(masterToken)).json();

    const sum = body.notifications.channels.reduce(
      (total: number, entry: { failed_total: number }) =>
        total + entry.failed_total,
      0,
    );

    expect(body.notifications.failed_total).toBe(sum);
  });
});

describe("the queue tables", () => {
  it("report the three the product actually queues on", async () => {
    const body = (await metrics(masterToken)).json();

    const tables = body.queue_tables.map(
      (entry: { table: string }) => entry.table,
    );

    expect(tables).toContain("domain_outbox_event");
    expect(tables).toContain("notification_delivery");
    expect(tables).toContain("ai_analysis_request");
  });

  it("and the dead-tuple percentage agrees with the rows it reports", async () => {
    /**
     * The shape, here; the arithmetic, in `metrics-math`.
     *
     * Making dead tuples appear on demand turned out to be a fight with
     * Postgres rather than with the product: the queue table starts nearly
     * empty, autovacuum's threshold is fifty dead rows, and the counter was
     * back to zero before the request went out — and with autovacuum disabled
     * for the table it stayed zero anyway. A test that cannot produce the
     * input it needs is a test that measures nothing, so the formula moved to
     * a pure function where the interesting case — dead rows against live
     * ones — is simply written down.
     */
    const body = (await metrics(masterToken)).json();

    for (const entry of body.queue_tables) {
      const total = entry.n_live_tup + entry.n_dead_tup;

      const expected =
        total > 0 ? Math.round((entry.n_dead_tup / total) * 100) : 0;

      expect(
        entry.dead_tuple_percent,
        `${entry.table}: ${entry.n_dead_tup} mortas de ${total}`,
      ).toBe(expected);
    }
  });
});

/**
 * What the meeting-wave features left for operators to watch (decisions 14.2,
 * 14.3/14.4 and 14.8): the deprecated app contracts still in use (removed
 * after 14 days without one), the device pre-check's agreement with the
 * server, and the proof signing certificate's state and end date.
 */
describe("the meeting-wave numbers", () => {
  it("count the legacy app contracts this replica served", async () => {
    const { countLegacyContractUse } = await import(
      "@/shared/http/legacy-contract-usage"
    );
    const before = (await metrics(masterToken)).json().legacy_contracts;

    countLegacyContractUse("legacy_proof_adapter");

    const after = (await metrics(masterToken)).json().legacy_contracts;

    expect(after.legacy_proof_adapter.count).toBe(
      before.legacy_proof_adapter.count + 1,
    );
    expect(after.legacy_proof_adapter.last_use_at).toEqual(expect.any(String));
    expect(after.legacy_pause_kind).toEqual({
      count: expect.any(Number),
      last_use_at: before.legacy_pause_kind.last_use_at,
    });
  });

  it("count the device pre-check's agreement per kind and result", async () => {
    const { countDeviceAgreement } = await import(
      "@/shared/ai-precheck/device-agreement-metrics"
    );
    const before = (await metrics(masterToken)).json()
      .ai_device_agreement_total;

    countDeviceAgreement("fuel_odometer", "DISAGREE");

    const after = (await metrics(masterToken)).json().ai_device_agreement_total;

    expect(after.fuel_odometer.DISAGREE).toBe(
      before.fuel_odometer.DISAGREE + 1,
    );
    expect(Object.keys(after).sort()).toEqual([
      "checklist_mileage",
      "fuel_odometer",
      "proof",
    ]);
  });

  it("show the proof signing certificate's state without its serial or CNPJ", async () => {
    const body = (await metrics(masterToken)).json();

    // The test stack configures no certificate.
    expect(body.proof_signing).toEqual({
      state: "ABSENT",
      reason: null,
      profile: null,
      signer_name: null,
      not_after: null,
      days_left: null,
    });
  });
});
