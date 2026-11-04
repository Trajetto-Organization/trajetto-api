import "reflect-metadata";
// The developer's .env sits in the folder this runs from; never read it.
import "./lib/no-env-file.cjs";

import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Dispatcher, type DriverAccess } from "./lib/admin";
import { NetworkFailure, ReplicaPool } from "./lib/api-client";
import { SimClock } from "./lib/clock";
import {
  simulatedCnpj,
  simulatedCpf,
  simulatedPlate,
  simulatedRenavam,
} from "./lib/documents";
import { distanceAlongToReach } from "./lib/geometry";
import {
  checklistPhoto,
  closedDoorPhoto,
  receiptPhoto,
  signatureImage,
} from "./lib/images";
import { SimLog } from "./lib/log";
import { TowerObserver } from "./lib/observer";
import { VirtualPhone, type OutboxFile } from "./lib/phone";
import {
  legIndexAt,
  loadFixture,
  planRoute,
  pointOnReturnLeg,
  type RoutePlan,
} from "./lib/route-plan";
import { seedCompany } from "./lib/seed";
import { towerRouteCheck } from "./lib/tower-checks";
import {
  CONTEXT_FILE,
  apiUrls,
  assertSimDatabase,
  simDatabaseUrl,
  workDirectory,
} from "./lib/sim-config";

/**
 * The delivery day, end to end, through the real HTTP API:
 *
 *   npx tsx tests/simulation/delivery-day.ts
 *
 * Five drivers, five routes of six stops from the CD in Vila Leopoldina
 * (São Paulo), a dispatcher on replica A and the phones dealt across the
 * replicas of SIM_API_URLS. See README.md for the scenes, the flags and how
 * to record it with the web.
 */

// ------------------------------------------------------------------ options

const SPEED = Number(process.env.SIM_SPEED ?? 8);
const SEED_ONLY = process.env.SIM_SEED_ONLY === "1";
const SELECTED = (process.env.SIM_ROUTES ?? "")
  .split(",")
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);
const RNG_SEED = Number(process.env.SIM_RANDOM_SEED ?? 20261103);

/** The app asks the GPS every 15 s; "every few seconds" here, for a denser trail. */
const FIX_SIM_MS = Number(process.env.SIM_FIX_SECONDS ?? 5) * 1000;

/** The reporter's minute (position-rules FLUSH_INTERVAL_MS), in simulated time. */
const FLUSH_SIM_MS = Number(process.env.SIM_FLUSH_SECONDS ?? 60) * 1000;

const WEB_URL = process.env.SIM_WEB_URL || "http://localhost:3100";

/** How long a driver's signal is lost on R-BUT (simulated), at least. */
const OFFLINE_SIM_MS = 3 * 60_000;

/** And how long the proof tapped in the dead zone waits in the outbox. */
const PROOF_HELD_SIM_MS = 60_000;

// ------------------------------------------------------------------ the cast

interface DriverCast {
  route: string;
  name: string;
  email: string;
  birthDate: string;
  access: DriverAccess;
  vehicle: {
    description: string;
    brand: string;
    model: string;
    mileage: number;
  };
}

/** Fictitious people; the passwords are throwaway and only for this run. */
function cast(password: (n: number) => string): DriverCast[] {
  return [
    {
      route: "R-PIN",
      name: "Ana Ribeiro",
      email: "ana.ribeiro@simulacao.invalid",
      birthDate: "1988-04-12",
      access: { kind: "qr" },
      vehicle: {
        description: "Fiorino Pinheiros",
        brand: "Fiat",
        model: "Fiorino",
        mileage: 42_180,
      },
    },
    {
      route: "R-PER",
      name: "Bruno Carvalho",
      email: "bruno.carvalho@simulacao.invalid",
      birthDate: "1985-09-30",
      access: { kind: "password-on-create", password: password(2) },
      vehicle: {
        description: "Kangoo Perdizes",
        brand: "Renault",
        model: "Kangoo",
        mileage: 51_340,
      },
    },
    {
      route: "R-BUT",
      name: "Carla Nogueira",
      email: "carla.nogueira@simulacao.invalid",
      birthDate: "1991-01-22",
      access: { kind: "password-on-create", password: password(3) },
      vehicle: {
        description: "Master Butantã",
        brand: "Renault",
        model: "Master",
        mileage: 63_905,
      },
    },
    {
      route: "R-MOE",
      name: "Diego Martins",
      email: "diego.martins@simulacao.invalid",
      birthDate: "1983-06-05",
      access: { kind: "password-reset", password: password(4) },
      vehicle: {
        description: "Sprinter Moema",
        brand: "Mercedes-Benz",
        model: "Sprinter",
        mileage: 38_770,
      },
    },
    {
      route: "R-CEN",
      name: "Elisa Prado",
      email: "elisa.prado@simulacao.invalid",
      birthDate: "1994-11-17",
      access: { kind: "password-reset", password: password(5) },
      vehicle: {
        description: "Daily Centro",
        brand: "Iveco",
        model: "Daily",
        mileage: 47_420,
      },
    },
  ];
}

const RECIPIENTS = [
  "Padaria",
  "Empório",
  "Farmácia",
  "Papelaria",
  "Mercearia",
  "Restaurante",
  "Floricultura",
];

const RECEIVERS = [
  "Marcos Lima",
  "Juliana Rocha",
  "Paulo Mendes",
  "Fernanda Alves",
  "Ricardo Souza",
  "Beatriz Costa",
  "Tiago Freitas",
];

/** What each route does besides delivering (README, "Cenas"). */
interface RouteScript {
  earlyArrivalAt?: number;
  absentAt?: number;
  authorizationAt?: number;
  offlineAt?: number;
  k12AfterStops?: number;
  cancel?: { afterStops: number; stopIndex: number };
  leaveOpenAfterStops?: number;
}

const SCRIPTS: Record<string, RouteScript> = {
  "R-PIN": { earlyArrivalAt: 1, absentAt: 4 },
  "R-PER": { k12AfterStops: 2 },
  "R-BUT": { offlineAt: 2 },
  "R-MOE": { authorizationAt: 1, leaveOpenAfterStops: 5 },
  "R-CEN": { cancel: { afterStops: 2, stopIndex: 3 } },
};

// ------------------------------------------------------------------ helpers

/** mulberry32: a small seeded generator, so two runs drive the same day. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Today in the company's zone, as the API's civil dates. */
function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function pngFile(fieldName: string, bytes: Buffer, name: string): OutboxFile {
  return {
    fieldName,
    bytes,
    contentType: "image/png",
    filename: `${name}.png`,
  };
}

/** Resolves with the first matching bus event, or null after `wallMs`. */
function nextEvent<T>(
  bus: EventEmitter,
  name: string,
  match: (payload: T) => boolean,
  wallMs: number,
): Promise<T | null> {
  return new Promise((done) => {
    const listener = (payload: T) => {
      if (!match(payload)) return;

      clearTimeout(timer);
      bus.off(name, listener);
      done(payload);
    };
    const timer = setTimeout(() => {
      bus.off(name, listener);
      done(null);
    }, wallMs);

    bus.on(name, listener);
  });
}

// ------------------------------------------------------------------ the run

interface DriverRun {
  cast: DriverCast;
  index: number;
  plan: RoutePlan;
  phone: VirtualPhone;
  driverId: string;
  userId: string;
  vehicleId: string;
  routeId: string | null;
  routeCode: number | null;

  /** Delivery id → index of the fixture stop. */
  deliveryIndex: Map<string, number>;
  deliveryIds: string[];
  script: RouteScript;
}

interface Context {
  clock: SimClock;
  rng: () => number;
  log: SimLog;
  bus: EventEmitter;
  dispatcher: Dispatcher;
  observer: TowerObserver;
  runs: DriverRun[];
  types: { delivered: string; absent: string; neighbour: string };
  reasonId: string;
  shipperId: string;
  scheduledDate: string;

  /** K12 and any other delivery added mid-route: id → metres along. */
  extraAlong: Map<string, number>;

  /** Facts the end-of-day checks read. */
  facts: {
    earlyArrival?: { deliveryId: string; distance: number };
    offlineProof?: { deliveryId: string; occurredAt: string };
    k12?: { deliveryId: string; routeId: string };
    cancelled?: { deliveryId: string; routeId: string };
    closedWithPending?: { routeId: string; result: Record<string, any> };
    authorization?: {
      occurrenceId: string;
      deliveryId: string;
      decision?: Record<string, any>;
    };
  };
}

const wallFor = (ctx: Context, simMs: number) => ctx.clock.toWallMs(simMs);

async function checkReplicas(urls: string[]): Promise<void> {
  for (const url of urls) {
    try {
      const response = await fetch(`${url}/health/liveness`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) throw new Error(`status ${response.status}`);
    } catch (error) {
      throw new Error(
        `A réplica ${url} não respondeu (${error instanceof Error ? error.message : error}). ` +
          "Suba com `npx tsx tests/simulation/scripts/start-replicas.ts`.",
      );
    }
  }
}

/** Settings, catalogues, people, vehicles: what the office does at 7 a.m. */
async function setUpCompany(
  ctx: Pick<Context, "dispatcher" | "log" | "clock" | "rng">,
  pool: ReplicaPool,
  fixture: ReturnType<typeof loadFixture>,
  businessId: string,
): Promise<Pick<Context, "types" | "reasonId" | "shipperId" | "runs">> {
  const { dispatcher, log, clock, rng } = ctx;

  await dispatcher.saveSettings({
    checklist_requirement: "ROUTE_START_AND_END",
    arrival_geofence_mode: "ALERT",
    arrival_geofence_radius_m: 300,
  });
  log.milestone("despacho", "settings-saved", {
    checklist: "ROUTE_START_AND_END",
    geofence: "ALERT 300 m",
  });

  const depot = fixture.depot;
  const branchId = await dispatcher.createBranch({
    name: depot.name,
    cnpj: simulatedCnpj(3),
    street: depot.street,
    number: depot.number,
    zip: depot.zip,
  });
  const fuelTypeId = await dispatcher.ensureFuelType("Diesel");
  const shipperId = await dispatcher.createShipper(
    "Distribuidora Paulista de Alimentos",
    simulatedCnpj(2),
  );

  const absent = await dispatcher.createOccurrenceType({
    name: "Cliente ausente",
    description: "Ninguém atendeu no endereço; foto da fachada obrigatória.",
    category: "NOT_DELIVERED",
    blocks_delivery: true,
    requires_photo: true,
  });

  const neighbour = await dispatcher.createOccurrenceType({
    name: "Entregue a vizinho",
    description: "Entrega a um vizinho, só com a autorização da torre.",
    category: "DELIVERED",
    requires_authorization: true,
    requires_receipt_photo: true,
  });

  const delivered = (
    await dispatcher.list("/occurrence-type/list-occurrence-type")
  ).find((row) => row.name === "Entrega normal");

  if (!delivered) throw new Error('O tipo padrão "Entrega normal" não existe.');

  const reasonId = await dispatcher.createStatusReason(
    "Cliente cancelou por telefone",
    "O destinatário ligou para a central cancelando o pedido.",
  );

  const passwords = new Map<number, string>();
  const password = (n: number) => {
    if (!passwords.has(n)) {
      passwords.set(n, `Mot${n}-${Math.floor(rng() * 1e9).toString(36)}x`);
    }

    return passwords.get(n) as string;
  };

  const people = cast(password);
  const routesByCode = new Map(
    fixture.routes.map((route) => [route.code, route]),
  );
  const runs: DriverRun[] = [];

  for (const [index, person] of people.entries()) {
    const fixtureRoute = routesByCode.get(person.route);

    if (!fixtureRoute) throw new Error(`Rota ${person.route} fora do fixture.`);

    const cpf = simulatedCpf(index + 1);
    const { driverId, userId } = await dispatcher.createDriver(
      {
        name: person.name,
        cpf,
        email: person.email,
        birthDate: person.birthDate,
        cnh: `9${String(1_000_000_000 + index * 13_579).slice(0, 10)}`,
        access: person.access,
      },
      branchId,
    );

    const vehicleId = await dispatcher.createVehicle(
      {
        description: person.vehicle.description,
        plate: simulatedPlate(index + 1),
        renavam: simulatedRenavam(index + 1),
        brand: person.vehicle.brand,
        model: person.vehicle.model,
        mileage: person.vehicle.mileage,
      },
      fuelTypeId,
      driverId,
      branchId,
    );

    const replica = pool.next();
    const phone = new VirtualPhone(
      `motorista:${person.route}`,
      person.route,
      replica,
      businessId,
      clock,
      log,
      seededRandom(RNG_SEED + index * 7_919),
      { fixSimMs: FIX_SIM_MS, flushSimMs: FLUSH_SIM_MS },
    );

    // The driver's way in: CPF + the password the manager set (D2 phase N),
    // or the QR code the manager shows the phone (D3), single-use.
    if (person.access.kind === "qr") {
      const enrollment = await dispatcher.issueEnrollment(userId);

      await phone.signIn({ kind: "qr", qrContent: enrollment.qrContent });
    } else {
      await phone.signIn({
        kind: "cpf",
        cpf,
        password: person.access.password,
      });
    }

    await phone.loadProfile();

    runs.push({
      cast: person,
      index,
      plan: planRoute(fixtureRoute),
      phone,
      driverId,
      userId,
      vehicleId,
      routeId: null,
      routeCode: null,
      deliveryIndex: new Map(),
      deliveryIds: [],
      script: SCRIPTS[person.route] ?? {},
    });
  }

  log.milestone("despacho", "drivers-signed-in", {
    drivers: runs.map((run) => ({
      route: run.cast.route,
      replica: run.phone.replica.label,
      access: run.cast.access.kind,
    })),
  });

  return {
    types: { delivered: delivered.id, absent, neighbour },
    reasonId,
    shipperId,
    runs,
  };
}

/** 30 deliveries (with coordinates), 5 routes, released. */
async function planTheDay(ctx: Context): Promise<void> {
  const { dispatcher, log } = ctx;

  for (const run of ctx.runs) {
    if (SELECTED.length > 0 && !SELECTED.includes(run.cast.route)) continue;

    const short = run.cast.route.slice(2);

    for (const [stopIndex, stop] of run.plan.stops.entries()) {
      const label = `${RECIPIENTS[(run.index + stopIndex) % RECIPIENTS.length]} ${stop.district}`;
      const id = await dispatcher.createDelivery(
        {
          code: `SIM-${short}-${String(stopIndex + 1).padStart(2, "0")}`,
          invoiceNumber: `${45_210 + run.index * 10 + stopIndex}`,
          recipientName: label,
          recipientTelephone: `119000${String(run.index * 10 + stopIndex).padStart(5, "0")}`,
          street: stop.street,
          number: stop.number,
          district: stop.district,
          zip: stop.zip,
          latitude: stop.lat,
          longitude: stop.lng,
          scheduledDate: ctx.scheduledDate,
          items: [
            {
              description: "Caixa de mercadorias",
              quantity: 2 + ((run.index + stopIndex) % 4),
              unit: "CX",
              unit_value: 89.9,
            },
          ],
        },
        ctx.shipperId,
      );

      run.deliveryIndex.set(id, stopIndex);
      run.deliveryIds.push(id);
    }

    const route = await dispatcher.createRoute({
      driverId: run.driverId,
      vehicleId: run.vehicleId,
      name: run.plan.name,
      scheduledDate: ctx.scheduledDate,
      deliveryIds: run.deliveryIds,
    });

    run.routeId = route.id;
    run.routeCode = route.code;

    await dispatcher.releaseRoute(route.id, route.planVersion);

    log.milestone("despacho", "route-released", {
      route: run.cast.route,
      routeId: route.id,
      code: route.code,
      stops: route.stops,
    });
  }

  log.milestone("despacho", "routes-released", {
    routes: ctx.runs.filter((run) => run.routeId).map((run) => run.cast.route),
  });
}

/** The dispatcher's reactions, each waiting for its moment of the day. */
function dispatcherAgenda(
  ctx: Context,
  active: DriverRun[],
): Array<Promise<void>> {
  const { bus, dispatcher, log, clock } = ctx;
  const tasks: Array<Promise<void>> = [];
  const dayWallMs = wallFor(ctx, 6 * 60 * 60_000);
  const isActive = (code: string) =>
    active.some((run) => run.cast.route === code);
  const runOf = (code: string) =>
    active.find((run) => run.cast.route === code) as DriverRun;

  // Scene 6: an occurrence that needs the tower's authorization.
  if (isActive("R-MOE")) {
    tasks.push(
      (async () => {
        const request = await nextEvent<{
          occurrenceId: string;
          deliveryId: string;
        }>(bus, "authorization-requested", () => true, dayWallMs);

        if (!request) return;

        // The tower learns of the request by its socket, as the web does.
        const announced =
          ctx.observer.authorizationFrames.length > 0 ||
          (await ctx.observer.waitFor(
            (event) => event === "occurrenceAuthorization",
            10_000,
          )) !== null;

        if (!announced) {
          log.anomaly(
            "despacho",
            "authorization request never reached the tower socket",
            request,
          );
        }

        await clock.sleepSim(60_000);

        const pending = await dispatcher.pendingAuthorizations();
        const item = pending.find((row) => row.id === request.occurrenceId);

        if (!item) {
          log.anomaly(
            "despacho",
            "authorization request missing from the tower queue",
            request,
          );
        }

        const decision = await dispatcher.decideAuthorization(
          request.occurrenceId,
          "APPROVED",
          "Vizinho confirmado por telefone com o destinatário.",
        );

        ctx.facts.authorization = { ...request, decision };
        log.milestone("despacho", "authorization-answered", {
          route: "R-MOE",
          occurrenceId: request.occurrenceId,
          status: decision.authorization_status,
          deliveryStatus: decision.deliveryStatus,
        });
      })(),
    );
  }

  // Scene 8 (K12): a delivery added to R-PER while it is on the street.
  if (isActive("R-PER")) {
    tasks.push(
      (async () => {
        const run = runOf("R-PER");
        const script = run.script;
        const done = await nextEvent<{ route: string; stopsDone: number }>(
          bus,
          "stop-done",
          (event) =>
            event.route === "R-PER" &&
            event.stopsDone >= (script.k12AfterStops ?? 2),
          dayWallMs,
        );

        if (!done || !run.routeId) return;

        await clock.sleepSim(45_000);

        const point = pointOnReturnLeg(run.plan, 0.45);
        const id = await dispatcher.createDelivery(
          {
            code: "SIM-PER-07",
            invoiceNumber: "45299",
            recipientName: "Quitanda Lapa (pedido urgente)",
            recipientTelephone: "11900000099",
            street: "Rua Guaicurus",
            number: "1000",
            district: "Lapa",
            zip: "05033002",
            latitude: Math.round(point.lat * 1e6) / 1e6,
            longitude: Math.round(point.lng * 1e6) / 1e6,
            scheduledDate: ctx.scheduledDate,
            items: [
              {
                description: "Engradado de frutas",
                quantity: 4,
                unit: "UN",
                unit_value: 45,
              },
            ],
          },
          ctx.shipperId,
        );

        const route = await dispatcher.getRoute(run.routeId);
        const added = await dispatcher.addStops(
          run.routeId,
          [id],
          route.plan_version,
        );

        ctx.extraAlong.set(id, point.along);
        ctx.facts.k12 = { deliveryId: id, routeId: run.routeId };

        log.milestone("despacho", "k12-added", {
          route: "R-PER",
          deliveryId: id,
          added: added.added,
          planVersion: added.planVersion,
        });
      })(),
    );
  }

  // Scene 9: the customer of a R-CEN stop calls to cancel.
  if (isActive("R-CEN")) {
    tasks.push(
      (async () => {
        const run = runOf("R-CEN");
        const cancel = run.script.cancel ?? { afterStops: 2, stopIndex: 3 };
        const done = await nextEvent<{ route: string; stopsDone: number }>(
          bus,
          "stop-done",
          (event) =>
            event.route === "R-CEN" && event.stopsDone >= cancel.afterStops,
          dayWallMs,
        );

        if (!done || !run.routeId) return;

        await clock.sleepSim(30_000);

        const deliveryId = run.deliveryIds[cancel.stopIndex];

        await dispatcher.cancelDelivery(
          deliveryId,
          ctx.reasonId,
          "Cliente ligou às 10h cancelando o pedido.",
        );

        ctx.facts.cancelled = { deliveryId, routeId: run.routeId };
        log.milestone("despacho", "stop-cancelled", {
          route: "R-CEN",
          deliveryId,
          stop: cancel.stopIndex + 1,
        });
      })(),
    );
  }

  // Scene 10 (K11): the route left open, closed with pending stops.
  if (isActive("R-MOE")) {
    tasks.push(
      (async () => {
        const left = await nextEvent<{ route: string; routeId: string }>(
          bus,
          "left-open",
          (event) => event.route === "R-MOE",
          dayWallMs,
        );

        if (!left) return;

        await clock.sleepSim(2 * 60_000);

        const result = await dispatcher.closeWithPending(
          left.routeId,
          "Motorista encerrou o turno; a última parada volta para reprogramação.",
        );

        ctx.facts.closedWithPending = { routeId: left.routeId, result };
        log.milestone("despacho", "route-closed-with-pending", {
          route: "R-MOE",
          cancelledStops: result.cancelledStops,
          status: result.status,
        });
      })(),
    );
  }

  // Each reaction waits most of the day; one that fails is a finding, and
  // must not surface as an unhandled rejection before the run awaits it.
  return tasks.map((task) =>
    task.catch((error) => {
      log.anomaly("despacho", "dispatcher reaction failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

/** One driver's day, as the app would live it. */
async function driveTheDay(ctx: Context, run: DriverRun): Promise<void> {
  const { clock, log, bus } = ctx;
  const { phone, plan, script } = run;
  const routeId = run.routeId as string;
  const route = run.cast.route;
  const depot = plan.line.points[0];

  phone.placeAt(depot[1], depot[0]);
  phone.connectSocket();

  // Departures spread over the first minutes, as a yard empties.
  await clock.sleepSim(run.index * 90_000);

  await phone.refreshDay();

  if (phone.openStops(routeId).length === 0) {
    log.anomaly(phone.actor, "released route missing from my-deliveries", {
      route,
    });
    return;
  }

  // Scene 3: the departure checklist of THIS route, then "Iniciar rota".
  const mileage = run.cast.vehicle.mileage;

  await phone.checklist({
    routeId,
    vehicleId: run.vehicleId,
    phase: "ROUTE_START",
    mileage: mileage + 1,
    photos: ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      (field) =>
        pngFile(
          field,
          checklistPhoto(`${route}-start-${field}`),
          `${field}-saida`,
        ),
    ),
  });
  log.milestone(phone.actor, "checklist-start", { route });

  await clock.sleepSim(45_000);

  // "Deseja realmente iniciar a rota?" → Sim.
  await phone.startRoute(routeId);
  log.milestone(phone.actor, "route-started", { route, routeId });
  await phone.refreshDay();

  let along = 0;
  let stopsDone = 0;
  const handled = new Set<string>();

  // Scene 7: the dead zone on R-BUT.
  let offlineStartSim: number | null = null;
  let proofQueuedAtSim: number | null = null;

  const signal = async () => {
    const now = clock.elapsedSimMs();

    if (
      offlineStartSim !== null &&
      phone.isOffline &&
      proofQueuedAtSim !== null &&
      now - offlineStartSim >= OFFLINE_SIM_MS &&
      now - proofQueuedAtSim >= PROOF_HELD_SIM_MS
    ) {
      await phone.goOnline();
    }
  };

  for (;;) {
    const open = phone
      .openStops(routeId)
      .filter((entry) => !handled.has(entry.delivery.id));

    if (open.length === 0) break;

    // Scene 10: R-MOE stops working with a stop still open.
    if (
      script.leaveOpenAfterStops !== undefined &&
      stopsDone >= script.leaveOpenAfterStops
    ) {
      await leaveRouteOpen(ctx, run, along);
      return;
    }

    const { delivery, stop } = open[0];
    const fixtureIndex = run.deliveryIndex.get(delivery.id);
    const target =
      fixtureIndex !== undefined
        ? plan.stopAlong[fixtureIndex]
        : ctx.extraAlong.get(delivery.id);

    if (target === undefined || target < along) {
      log.anomaly(
        phone.actor,
        "open stop with no place on the route geometry",
        {
          route,
          deliveryId: delivery.id,
        },
      );
      handled.add(delivery.id);
      continue;
    }

    const stopNumber = (fixtureIndex ?? plan.stops.length) + 1;

    if (stop.status === "PENDING") await phone.onTheWay(routeId, stop.id);

    const speedKmh = plan.legSpeedKmh[legIndexAt(plan, target - 1)];

    const onStep = async (state: { remainingSimMs: number }) => {
      if (
        script.offlineAt !== undefined &&
        fixtureIndex === script.offlineAt &&
        offlineStartSim === null &&
        state.remainingSimMs <= 60_000
      ) {
        offlineStartSim = clock.elapsedSimMs();
        phone.goOffline();
      }

      await signal();
    };

    // Scene 5: one arrival tapped ~600 m before the door (ALERT: flagged).
    if (
      script.earlyArrivalAt !== undefined &&
      fixtureIndex === script.earlyArrivalAt
    ) {
      const early = Math.max(
        along,
        distanceAlongToReach(
          plan.line,
          [delivery.longitude, delivery.latitude],
          600,
          target,
        ),
      );

      await phone.drive(plan.line, along, early, speedKmh, onStep);
      along = early;

      const answer = await phone.arrival(delivery, {
        routeId,
        stopId: stop.id,
      });

      ctx.facts.earlyArrival = {
        deliveryId: delivery.id,
        distance: Math.round(target - early),
      };
      log.milestone(phone.actor, "geofence-flag", {
        route,
        stop: stopNumber,
        deliveryId: delivery.id,
        outcome: answer?.outcome ?? "blocked",
      });

      // Then on to the door, slowly, to deliver inside the radius.
      await phone.drive(plan.line, along, target, 18, onStep);
      along = target;
    } else {
      await phone.drive(plan.line, along, target, speedKmh, onStep);
      along = target;

      if (stop.status !== "ARRIVED") {
        await phone.arrival(delivery, { routeId, stopId: stop.id });
      }
    }

    log.event(phone.actor, "stop-arrived", {
      route,
      stop: stopNumber,
      deliveryId: delivery.id,
    });

    const dwellSimMs =
      script.offlineAt !== undefined && fixtureIndex === script.offlineAt
        ? 90_000
        : 120_000 + Math.floor(ctx.rng() * 90_000);

    await phone.dwell(dwellSimMs, signal);

    // Scene 6: the outcome at the door.
    if (fixtureIndex !== undefined && fixtureIndex === script.absentAt) {
      const type = (phone.day?.occurrence_types ?? []).find(
        (row: Record<string, any>) => row.id === ctx.types.absent,
      ) ?? { id: ctx.types.absent, form_version: 1 };

      const answer = await phone.reportOccurrence({
        delivery,
        type,
        description: "Ninguém atendeu; interfone sem resposta.",
        photo: pngFile("photos", closedDoorPhoto(delivery.id), "fachada"),
      });

      log.milestone(phone.actor, "occurrence-absent", {
        route,
        stop: stopNumber,
        deliveryId: delivery.id,
        outcome: answer?.outcome,
      });
    } else if (
      fixtureIndex !== undefined &&
      fixtureIndex === script.authorizationAt
    ) {
      await deliverToNeighbour(ctx, run, delivery, stopNumber);
    } else {
      const type = (phone.day?.delivered_types ?? []).find(
        (row: Record<string, any>) => row.id === ctx.types.delivered,
      ) ?? { id: ctx.types.delivered, form_version: 1 };

      const answer = await phone.deliver({
        delivery,
        type,
        receivedBy: RECEIVERS[(run.index + stopsDone) % RECEIVERS.length],
        receipt: pngFile("receipt_photo", receiptPhoto(delivery.id), "canhoto"),
        signature:
          stopsDone % 2 === 0
            ? pngFile("signature", signatureImage(delivery.id), "assinatura")
            : undefined,
      });

      if (answer?.outcome === "queued" && phone.isOffline) {
        proofQueuedAtSim = clock.elapsedSimMs();
        ctx.facts.offlineProof = {
          deliveryId: delivery.id,
          occurredAt: phone.lastSubmission?.occurredAt ?? "",
        };
      }

      log.milestone(phone.actor, "proof", {
        route,
        stop: stopNumber,
        deliveryId: delivery.id,
        outcome: answer?.outcome,
      });
    }

    handled.add(delivery.id);
    stopsDone += 1;
    bus.emit("stop-done", { route, stopsDone, deliveryId: delivery.id });

    await phone.dwell(20_000, signal);

    // The list is fetched again after every action (invalidateList); a
    // phone without signal keeps its cached day.
    try {
      await phone.refreshDay();
    } catch (error) {
      if (!(error instanceof NetworkFailure)) throw error;
    }
  }

  // Still in the dead zone when the work ran out: the signal comes back.
  if (phone.isOffline) await phone.goOnline();

  await finishRoute(ctx, run, along);
}

/** Scene 6b: "Entregue a vizinho" waits for the tower, then the driver goes on. */
async function deliverToNeighbour(
  ctx: Context,
  run: DriverRun,
  delivery: Record<string, any>,
  stopNumber: number,
): Promise<void> {
  const { phone } = run;
  const type = (phone.day?.delivered_types ?? []).find(
    (row: Record<string, any>) => row.id === ctx.types.neighbour,
  ) ?? { id: ctx.types.neighbour, form_version: 1 };

  const answer = await phone.deliver({
    delivery,
    type,
    receivedBy: "Sr. Antônio (vizinho do 52)",
    receipt: pngFile(
      "receipt_photo",
      receiptPhoto(`${delivery.id}-vizinho`),
      "canhoto",
    ),
  });

  const report =
    answer?.outcome === "sent"
      ? (answer.data.data as Record<string, any>)
      : null;

  ctx.log.milestone(phone.actor, "authorization-requested", {
    route: run.cast.route,
    stop: stopNumber,
    deliveryId: delivery.id,
    status: report?.authorization_status,
  });

  if (!report || report.authorization_status !== "PENDING") {
    ctx.log.anomaly(
      phone.actor,
      "delivery to a neighbour did not wait for the tower",
      {
        report,
      },
    );
    return;
  }

  ctx.facts.authorization = {
    occurrenceId: report.id,
    deliveryId: delivery.id,
  };
  ctx.bus.emit("authorization-requested", {
    occurrenceId: report.id,
    deliveryId: delivery.id,
  });

  // "Aguardando autorização da torre": the driver waits at the door until
  // the decision reaches the phone (socket frame + refetch, or the next poll).
  for (let waited = 0; waited < 20 * 60_000; waited += 20_000) {
    await phone.dwell(20_000);
    await phone.refreshDay();

    const still = (phone.day?.data ?? []).find(
      (row: Record<string, any>) => row.id === delivery.id,
    );

    if (!still || still.authorization_request?.status !== "PENDING") {
      ctx.log.event(phone.actor, "authorization-seen", {
        route: run.cast.route,
        deliveryId: delivery.id,
        status: still?.authorization_request?.status ?? "resolved",
      });
      return;
    }
  }

  ctx.log.anomaly(
    phone.actor,
    "authorization never answered within 20 simulated minutes",
    {
      deliveryId: delivery.id,
    },
  );
}

/** Scene 10: drives back past the last stop and waits; the office closes it. */
async function leaveRouteOpen(
  ctx: Context,
  run: DriverRun,
  along: number,
): Promise<void> {
  const { phone, plan } = run;
  const routeId = run.routeId as string;
  const speedKmh = plan.legSpeedKmh[plan.legSpeedKmh.length - 1];

  ctx.log.event(phone.actor, "shift-ended-with-open-stop", {
    route: run.cast.route,
  });

  await phone.drive(plan.line, along, plan.line.length, speedKmh);

  ctx.bus.emit("left-open", { route: run.cast.route, routeId });
  ctx.log.milestone(phone.actor, "route-left-open", {
    route: run.cast.route,
    routeId,
  });

  // The app keeps tracking while the route runs; it stops when the list no
  // longer shows the route open (shouldTrack) or the API answers
  // tracking: false.
  for (
    let waited = 0;
    waited < 30 * 60_000 && phone.tracking;
    waited += 30_000
  ) {
    await phone.dwell(30_000);
    await phone.refreshDay();

    if (phone.openStops(routeId).length === 0) phone.tracking = false;
  }

  await endChecklist(ctx, run);
}

/** The route closed itself on the last stop: back to the CD, off the map. */
async function finishRoute(
  ctx: Context,
  run: DriverRun,
  along: number,
): Promise<void> {
  const { phone, plan } = run;
  const { clock } = ctx;
  const routeId = run.routeId as string;

  await phone.refreshDay();

  // shouldTrack: no route of the driver IN_PROGRESS any more, the GPS stops.
  if (phone.openStops(routeId).length === 0) phone.tracking = false;

  ctx.log.milestone(phone.actor, "route-completed", {
    route: run.cast.route,
    routeId,
  });

  // The drive back is not tracked (privacy rule: only while a route runs).
  const remaining = Math.max(0, plan.line.length - along);
  const speedMs = plan.legSpeedKmh[plan.legSpeedKmh.length - 1] / 3.6;

  await clock.sleepSim((remaining / speedMs) * 1000);

  const depot = plan.line.points[0];

  phone.placeAt(depot[1], depot[0]);

  await endChecklist(ctx, run);
}

async function endChecklist(ctx: Context, run: DriverRun): Promise<void> {
  const { phone, plan } = run;
  const km = Math.ceil(plan.line.length / 1000);

  await phone.checklist({
    routeId: run.routeId as string,
    vehicleId: run.vehicleId,
    phase: "ROUTE_END",
    mileage: run.cast.vehicle.mileage + km + 2,
    photos: ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      (field) =>
        pngFile(
          field,
          checklistPhoto(`${run.cast.route}-end-${field}`),
          `${field}-chegada`,
        ),
    ),
  });

  ctx.log.milestone(phone.actor, "checklist-end", { route: run.cast.route });
  ctx.bus.emit("route-finished", { route: run.cast.route });
}

/** What the API says at the end of the day, compared with what happened. */
async function verifyTheDay(
  ctx: Context,
  active: DriverRun[],
): Promise<Array<{ check: string; ok: boolean; detail: string }>> {
  const { dispatcher, observer } = ctx;
  const towerReplica = dispatcher.api.replica;
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail: string) =>
    checks.push({ check, ok, detail });

  for (const run of active) {
    const route = await dispatcher.getRoute(run.routeId as string);
    const stops = (route.stops ?? []) as Array<Record<string, any>>;
    const statuses = stops.map((stop) => stop.status).join(",");

    add(
      `${run.cast.route}: rota concluída`,
      route.status === "COMPLETED",
      `status ${route.status}; paradas ${statuses}`,
    );

    if (run.script.leaveOpenAfterStops !== undefined) {
      add(
        `${run.cast.route}: encerrada com pendências (K11)`,
        Boolean(route.closure_reason) &&
          stops.some((stop) => stop.status === "CANCELLED"),
        `closure_reason ${route.closure_reason ?? "—"}`,
      );
    }

    if (run.script.k12AfterStops !== undefined) {
      add(
        `${run.cast.route}: entrega adicionada em rota (K12) entregue`,
        stops.length === run.plan.stops.length + 1 &&
          stops.every((stop) => stop.status === "COMPLETED"),
        `${stops.length} paradas: ${statuses}`,
      );
    }

    if (run.script.cancel) {
      add(
        `${run.cast.route}: parada cancelada pelo despacho`,
        stops.filter((stop) => stop.status === "CANCELLED").length === 1,
        statuses,
      );
    }

    // Scenes 8 and 9: the plan change reached the driver's own socket (on
    // the driver's replica, caused by the dispatcher on replica A).
    if (run.script.k12AfterStops !== undefined || run.script.cancel) {
      add(
        `${run.cast.route}: motorista avisado em tempo real (socket na réplica ${run.phone.replica.label})`,
        run.phone.stats.socketFrames > 0,
        `${run.phone.stats.planChangedFrames} route.stops_changed, ${run.phone.stats.socketFrames} frames no total`,
      );
    }

    // Scene 11: every live update of this phone reached the tower on replica A.
    const seen = observer.positions.get(run.driverId) ?? 0;

    add(
      `${run.cast.route}: posições chegaram à torre na réplica A (via ${run.phone.replica.label})`,
      run.phone.stats.advancedFlushes === 0 || seen > 0,
      `${seen} frames driverPosition / ${run.phone.stats.advancedFlushes} envios que avançaram`,
    );

    // Scene 11, the route half: a phone on another replica than the tower's
    // started, moved and settled this route there; every routeEvent of it
    // has to have crossed the Redis adapter to the tower — stop by stop, for
    // each "a caminho" and arrival the API accepted from the phone.
    if (run.routeId && run.phone.replica.label !== towerReplica) {
      // The last frames of the day may still be on their way.
      await observer.waitForRouteEvent(run.routeId, "route.completed", 5_000);

      checks.push(
        towerRouteCheck(
          {
            route: run.cast.route,
            towerReplica,
            phoneReplica: run.phone.replica.label,
            stops: stops.map((stop) => ({
              id: String(stop.id),
              status: String(stop.status),
            })),
            accepted: run.phone.acceptedOf(run.routeId),
            closedWithPending: run.script.leaveOpenAfterStops !== undefined,
            planChanged: run.script.k12AfterStops !== undefined,
          },
          observer.routeEventsOf(run.routeId),
        ),
      );
    }
  }

  if (ctx.facts.earlyArrival) {
    const delivery = await dispatcher.getDelivery(
      ctx.facts.earlyArrival.deliveryId,
    );
    const events = (delivery.events ?? []) as Array<Record<string, any>>;
    const arrival = events.find((event) => event.type === "ARRIVAL");

    add(
      "R-PIN: chegada a ~600 m sinalizada fora do raio (ALERTAR)",
      arrival?.geofence_outcome === "OUTSIDE",
      `geofence_outcome ${arrival?.geofence_outcome ?? "—"}, distance_m ${arrival?.distance_m ?? "—"}`,
    );
  }

  if (ctx.facts.offlineProof?.deliveryId) {
    const delivery = await dispatcher.getDelivery(
      ctx.facts.offlineProof.deliveryId,
    );

    add(
      "R-BUT: comprovante da fila offline mantém o horário do toque",
      Boolean(delivery.delivered_at) &&
        Math.abs(
          Date.parse(delivery.delivered_at) -
            Date.parse(ctx.facts.offlineProof.occurredAt),
        ) < 2_000,
      `delivered_at ${delivery.delivered_at}, toque ${ctx.facts.offlineProof.occurredAt}`,
    );
  }

  if (ctx.facts.authorization) {
    add(
      "R-MOE: entrega a vizinho autorizada pela torre",
      ctx.facts.authorization.decision?.authorization_status === "APPROVED",
      JSON.stringify(ctx.facts.authorization.decision ?? null).slice(0, 160),
    );
  }

  return checks;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL || simDatabaseUrl();

  assertSimDatabase(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;

  const urls = apiUrls();
  const work = workDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = resolve(
    process.env.SIM_LOG || resolve(work, `delivery-day-${stamp}.jsonl`),
  );

  mkdirSync(work, { recursive: true });

  await checkReplicas(urls);

  const clock = new SimClock({ speed: SPEED });
  const log = new SimLog(logPath, clock);
  const rng = seededRandom(RNG_SEED);
  const pool = new ReplicaPool(urls);
  const fixture = loadFixture();

  log.info("sim", `log em ${logPath}`, {
    speed: SPEED,
    replicas: urls,
    routes:
      SELECTED.length > 0
        ? SELECTED
        : fixture.routes.map((route) => route.code),
    fixSimMs: FIX_SIM_MS,
    flushSimMs: FLUSH_SIM_MS,
    geometry: fixture.generatedFrom,
  });

  const company = await seedCompany();

  log.milestone("sim", "company-seeded", { businessId: company.businessId });

  const replicaA = pool.dispatcher();
  const dispatcher = new Dispatcher(
    replicaA.url,
    replicaA.label,
    log,
    company.businessId,
  );

  await dispatcher.signIn(company.adminEmail, company.adminPassword);

  const observer = new TowerObserver(dispatcher.api, log);

  await observer.connect();

  const base = {
    clock,
    rng,
    log,
    bus: new EventEmitter(),
    dispatcher,
    observer,
    scheduledDate: todayInSaoPaulo(),
    extraAlong: new Map<string, number>(),
    facts: {},
  };

  const setup = await setUpCompany(base, pool, fixture, company.businessId);
  const ctx: Context = { ...base, ...setup };

  ctx.bus.setMaxListeners(50);

  await planTheDay(ctx);

  const contextPath = resolve(work, CONTEXT_FILE);
  const writeContext = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      contextPath,
      JSON.stringify(
        {
          note: "Gerado pela simulação; credenciais descartáveis do banco trajetto_sim.",
          webUrl: WEB_URL,
          apiUrls: urls,
          businessId: company.businessId,
          admin: { email: company.adminEmail, password: company.adminPassword },
          logPath,
          speed: SPEED,
          startedAt: new Date(clock.startedAt).toISOString(),
          routes: ctx.runs
            .filter((run) => run.routeId)
            .map((run) => ({
              code: run.cast.route,
              id: run.routeId,
              number: run.routeCode,
              driver: run.cast.name,
              replica: run.phone.replica.label,
            })),
          ...extra,
        },
        null,
        2,
      ),
    );

  writeContext();
  log.info("sim", `contexto em ${contextPath}`);

  const active = ctx.runs.filter((run) => run.routeId);
  let checks: Array<{ check: string; ok: boolean; detail: string }> = [];

  if (!SEED_ONLY) {
    const agenda = dispatcherAgenda(ctx, active);
    const drivers = active.map((run) =>
      driveTheDay(ctx, run).catch((error) => {
        log.anomaly(run.phone.actor, "driver stopped by an error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }),
    );

    await Promise.all(drivers);

    // Reactions that never fired (their route was not selected or failed)
    // must not hold the run open.
    await Promise.race([Promise.all(agenda), clock.sleepSim(3 * 60_000)]);

    log.milestone("sim", "day-finished");

    checks = await verifyTheDay(ctx, active);
  }

  for (const run of ctx.runs) run.phone.closeSocket();
  observer.close();

  const failedChecks = checks.filter((check) => !check.ok);
  const summary = {
    unexpectedCount: log.unexpected.length,
    checks,
    phones: ctx.runs.map((run) => ({
      route: run.cast.route,
      replica: run.phone.replica.label,
      ...run.phone.stats,
      towerFrames: run.driverId
        ? (observer.positions.get(run.driverId) ?? 0)
        : 0,
      towerRouteEvents: run.routeId
        ? Object.fromEntries(observer.routeEventsOf(run.routeId).counts)
        : {},
      // Stop by stop: what the API accepted from the phone, and the stops the
      // tower saw "a caminho" (the socket-frame lines carry the rest).
      acceptedStops: run.routeId ? run.phone.acceptedOf(run.routeId) : null,
      towerOnTheWayStops: run.routeId
        ? [...observer.routeEventsOf(run.routeId).onTheWay]
        : [],
    })),
    towerRouteEvents: Object.fromEntries(observer.routeEvents),
    elapsedWallMs: clock.wallNow() - clock.startedAt,
    elapsedSimMs: clock.elapsedSimMs(),
  };

  writeContext({ finishedAt: clock.wallIso(), summary });
  await log.close(summary);

  console.log("\n[sim] Verificações:");
  for (const check of checks) {
    console.log(
      `  ${check.ok ? "OK  " : "FALHA"} ${check.check} — ${check.detail}`,
    );
  }
  console.log(
    `[sim] ${log.unexpected.length} respostas/comportamentos inesperados; log: ${logPath}`,
  );

  if (log.unexpected.length > 0 || failedChecks.length > 0)
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
