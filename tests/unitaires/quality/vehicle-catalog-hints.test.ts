import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every write that changes a vehicle tells the vehicle lists after its
 * commit (`catalogChanged` vehicle, audit of 25/11/2026).
 *
 * The web trusts its vehicle lists for two minutes and the app its own, on
 * the promise that this hint keeps them current; only the vehicle's own
 * create, edit and delete sent it. A route's departure and return
 * (syncVehicleStatus), a refuelling, a checklist and a service order moved
 * the status, the odometer or the last maintenance in silence, and the
 * selector kept the old "Em rota" badge, the old km, until a reload.
 *
 * So the writes on the vehicle table in src/ are listed here, by text:
 *
 *  - WRITERS: each file that writes the table (Prisma `.vehicle.<write>(`
 *    or raw SQL), with the entry points that reach the write. A file that
 *    starts writing the table fails until it is listed;
 *  - every file in src/ that calls an entry point must emit
 *    (announceVehicleChanged, announceRouteVehicle, announceStopSettled —
 *    which announces the route's truck — or the vehicle use cases' own
 *    `sendCatalogChangedEvent(…, "vehicle")`), be a writer itself (a
 *    repository composing another's write), hand its result to files that
 *    emit (RELAYS), or say why the call never moves a vehicle (EXEMPT).
 *
 * A grep, not a proof of every branch: what it guarantees is that nobody
 * adds a vehicle write, or a new caller of one, without deciding where its
 * hint goes.
 */
const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Each file that writes the table, and the calls that reach the write. */
const WRITERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "src/modules/route/repositories/route-repository.ts",
    // syncVehicleStatus: the departure and the end of a route that left.
    ["transitionRoute", "closeWithPending", "settleStopForDelivery"],
  ],
  [
    "src/modules/fuel/repositories/fuel-repository.ts",
    ["createFuelWithMileage", "updateFuelAndMileage", "deleteFuel"],
  ],
  [
    "src/modules/vehicle-checklist/repositories/vehicle-checklist-repository.ts",
    [
      "createVehicleChecklistWithMileage",
      "updateVehicleChecklistAndMileage",
      "deleteVehicleChecklist",
    ],
  ],
  ["src/shared/vehicle/odometer-timeline.ts", ["releaseOdometer"]],
  [
    "src/modules/vehicle/repositories/vehicle-repository.ts",
    [
      "createVehicle",
      "createVehicleWithinLimit",
      "updateVehicle",
      "updateVehicleWithinLimit",
      "advanceMileageAfterService",
      "deleteVehicle",
    ],
  ],
];

/** Callers that hand their result to the files that emit, after commit. */
const RELAYS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // The stop a proof or an occurrence settled goes back to the use case,
  // which announces it (announceStopSettled) once the transaction is over.
  [
    "src/modules/delivery/usecases/register-delivery-proof/delivery-proof-effect.ts",
    [
      "src/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase.ts",
      "src/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-usecase.ts",
    ],
  ],
  [
    "src/modules/delivery/usecases/report-delivery-occurrence/occurrence-effect.ts",
    [
      "src/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase.ts",
      "src/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-usecase.ts",
    ],
  ],
  // The service order's mileage helpers run inside the order's transaction.
  [
    "src/modules/service-order/usecases/service-order-mileage.ts",
    [
      "src/modules/service-order/usecases/create-service-order/create-service-order-usecase.ts",
      "src/modules/service-order/usecases/update-service-order/update-service-order-usecase.ts",
    ],
  ],
];

/**
 * Callers whose call never moves a vehicle. The release and the pull back
 * to planning: syncVehicleStatus moves the truck only on a departure or the
 * end of a route that left (routeMovesVehicle).
 */
const EXEMPT: readonly string[] = [
  "src/modules/route/usecases/release-route/release-route-usecase.ts",
];

const writerFiles = WRITERS.map(([file]) => file);
const relayFiles = RELAYS.map(([file]) => file);

const EMITS =
  /announceVehicleChanged\(|announceRouteVehicle\(|announceStopSettled\(|sendCatalogChangedEvent\([^)]*"vehicle"\)/;

const PRISMA_WRITE =
  /\.vehicle\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/;
const RAW_WRITE = /(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"vehicle"[\s(]/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      // The twins mirror the repositories; they never run in production.
      return name === "in-memory" ? [] : sources(path);
    }

    return path.endsWith(".ts") ? [path] : [];
  });
}

/** The path from the repository's root, with forward slashes. */
const rel = (file: string) => relative(ROOT, file).split("\\").join("/");

const files = sources(SRC).map((path) => ({
  path: rel(path),
  text: readFileSync(path, "utf8"),
}));
const textOf = (path: string) =>
  files.find((file) => file.path === path)?.text ?? "";

describe("the writes on the vehicle table", () => {
  it("are all listed, and every listed file still writes it", () => {
    const writing = files
      .filter(({ text }) => PRISMA_WRITE.test(text) || RAW_WRITE.test(text))
      .map(({ path }) => path)
      .sort();

    expect(writing).toEqual([...writerFiles].sort());
  });

  it("are reached only through callers that announce the vehicle", () => {
    const unannounced: string[] = [];

    for (const [writer, entryPoints] of WRITERS) {
      for (const entry of entryPoints) {
        const call = new RegExp(`(?<!function )\\b${entry}\\(`);
        const callers = files.filter(
          ({ path, text }) =>
            path !== writer &&
            call.test(text) &&
            // A repository interface declares `name: (`, not a call.
            !/\/I[A-Z][\w-]*-repository\.ts$/.test(path),
        );

        for (const { path, text } of callers) {
          const covered =
            EMITS.test(text) ||
            writerFiles.includes(path) ||
            relayFiles.includes(path) ||
            EXEMPT.includes(path);

          if (!covered) unannounced.push(`${path} → ${entry}`);
        }
      }
    }

    expect(unannounced).toEqual([]);
  });

  it("relay to files that announce", () => {
    for (const [relay, targets] of RELAYS) {
      expect(textOf(relay), relay).not.toBe("");

      for (const target of targets) {
        expect(EMITS.test(textOf(target)), `${relay} → ${target}`).toBe(true);
      }
    }
  });

  it("include the stop that closed a route: announceStopSettled tells it", () => {
    expect(textOf("src/shared/route/route-realtime.ts")).toMatch(
      /announceRouteVehicle\(businessId, settled\.closedRoute\)/,
    );
  });
});
