import { describe, expect, it } from "vitest";

import { readdirSync } from "node:fs";
import path from "node:path";

import { AppError } from "@/shared/errors/AppError";

import { MAINTENANCE_HTTP_ERRORS } from "@/modules/service-order/usecases/errors/maintenance-http-errors";
import { CHECKLIST_HTTP_ERRORS } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-http-errors";
import { VEHICLE_HTTP_ERRORS } from "@/modules/vehicle/usecases/errors/vehicle-http-errors";
import { VEHICLE_TYPE_HTTP_ERRORS } from "@/modules/vehicle-type/usecases/errors/vehicle-type-http-errors";

/**
 * Every domain error of the I–Z modules reaches a client with an honest
 * status and a code (decision 11.3).
 *
 * A plain `Error` used to leave its controller as an inline `{ message }`
 * with no code (or, when no controller caught it, as a 500). Now each class
 * is an AppError — status and code travel with it to the global handler —
 * or is answered by its module's HTTP table, which sends a code too.
 */
const MODULES = [
  "import",
  "kanban",
  "notification",
  "occurrence-type",
  "part",
  "permission",
  "profile-access",
  "quote",
  "route",
  "service-order",
  "service-order-part",
  "shipper",
  "status-change-reason",
  "supplier",
  "user",
  "vehicle",
  "vehicle-checklist",
  "vehicle-type",
  "whatsapp",
  "driver-pause",
];

const ROOT = path.resolve(__dirname, "../../../src/modules");

/**
 * Internal signals: never sent as they are, each one is converted where it
 * is caught (the route use cases turn them into AppErrors with a code; the
 * stop-on-the-way and pause-report rules into their own answers).
 */
const INTERNAL_SIGNALS = new Set([
  "RouteNotBelongBusinessError",
  "RouteStatusConflictError",
  "RouteVehicleBusyError",
  "RouteDriverBusyError",
  "DeliveryAlreadyOnRouteError",
  "DeliveryNoLongerRoutableError",
  "RouteDriverInactiveError",
  "RouteVehicleUnavailableError",
  "RouteStopNotFoundError",
  "RouteReorderMismatchError",
  "RouteCodeTakenError",
  "RoutePlanStaleError",
  "RouteStopsLimitError",
  // Carries the photo report the controller answers with (400 PHOTOS_REQUIRED).
  "VehicleChecklistRequiredPhotosMissingError",
]);

const TABLES = [
  ...MAINTENANCE_HTTP_ERRORS,
  ...CHECKLIST_HTTP_ERRORS,
  ...VEHICLE_HTTP_ERRORS,
  ...VEHICLE_TYPE_HTTP_ERRORS,
];

type ErrorClass = new (...args: unknown[]) => Error;

let cached: Promise<Array<[string, ErrorClass]>> | undefined;

// Imported once: ~100 modules, slow on a loaded machine.
function errorClasses(): Promise<Array<[string, ErrorClass]>> {
  cached ??= loadErrorClasses();

  return cached;
}

async function loadErrorClasses(): Promise<Array<[string, ErrorClass]>> {
  const found: Array<[string, ErrorClass]> = [];

  for (const module of MODULES) {
    const directory = path.join(ROOT, module, "usecases", "errors");
    let files: string[] = [];

    try {
      files = readdirSync(directory).filter(
        (file) => file.endsWith(".ts") && !file.endsWith("-http-errors.ts"),
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const exported = (await import(path.join(directory, file))) as Record<
        string,
        unknown
      >;

      for (const [name, value] of Object.entries(exported)) {
        if (typeof value === "function" && value.prototype instanceof Error) {
          found.push([`${module}/${name}`, value as ErrorClass]);
        }
      }
    }
  }

  return found;
}

function instantiate(Class: ErrorClass): Error {
  // Constructors take counts, names or details; any value builds a message.
  return new Class(...Array.from({ length: Class.length }, () => 1));
}

describe("I–Z domain errors carry an honest status and a code", () => {
  it("finds the error classes it is guarding", async () => {
    expect((await errorClasses()).length).toBeGreaterThan(60);
  }, 60_000);

  it("every class is an AppError with a 4xx and a real code, or is mapped by its module's table", async () => {
    const offenders: string[] = [];

    for (const [name, Class] of await errorClasses()) {
      const shortName = name.split("/")[1];

      if (INTERNAL_SIGNALS.has(shortName)) continue;

      const error = instantiate(Class);

      if (error instanceof AppError) {
        const honest =
          error.statusCode >= 400 &&
          error.statusCode < 500 &&
          /^[A-Z][A-Z0-9_]+$/.test(error.code) &&
          error.code !== "BAD_REQUEST";

        if (!honest) {
          offenders.push(`${name}: ${error.statusCode} ${error.code}`);
        }

        // Reserved for the unknown-endpoint 404 (http.ts): the app's outbox
        // reads it as "this build is outdated" and replays the submission.
        if (error.code === "ROUTE_NOT_FOUND") {
          offenders.push(`${name}: uses the reserved ROUTE_NOT_FOUND`);
        }

        continue;
      }

      const mapped = TABLES.some(([type]) => error instanceof type);

      if (!mapped) offenders.push(`${name}: plain Error with no table entry`);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it("answers the cases clients branch on with the agreed status", () => {
    // Spot checks of the contract the web and the app read (decision 11.3).
    const cases: Array<[Error, number, string]> = [];

    return Promise.all([
      import("@/modules/user/usecases/errors/resource-not-found-error"),
      import(
        "@/modules/notification/usecases/errors/notification-not-authorized-error"
      ),
      import("@/modules/quote/usecases/errors/quote-already-finalized-error"),
      import(
        "@/modules/whatsapp/usecases/errors/whatsapp-phone-already-in-use-error"
      ),
      import(
        "@/modules/profile-access/usecases/errors/profile-access-in-use-error"
      ),
      import("@/modules/user/usecases/errors/user-invalid-credentials-error"),
    ]).then(([user, notification, quote, whatsapp, profile, credentials]) => {
      cases.push(
        [new user.ResourceNotFoundError(), 404, "USER_NOT_FOUND"],
        // Someone else's notification: the same answer as a missing one.
        [
          new notification.NotificationNotAuthorizedError(),
          404,
          "NOTIFICATION_NOT_FOUND",
        ],
        [
          new quote.QuoteAlreadyFinalizedError(),
          409,
          "QUOTE_ALREADY_FINALIZED",
        ],
        [
          new whatsapp.WhatsAppPhoneAlreadyInUseError(),
          409,
          "WHATSAPP_PHONE_TAKEN",
        ],
        [new profile.ProfileAccessInUseError(2), 409, "PROFILE_ACCESS_IN_USE"],
        [
          new credentials.UserInvalidCredentialsError(),
          401,
          "AUTH_INVALID_CREDENTIALS",
        ],
      );

      for (const [error, status, code] of cases) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ statusCode: status, code });
      }

      // The extra field the delete answer carries survives the promotion.
      expect(new profile.ProfileAccessInUseError(3).usersCount).toBe(3);
    });
  });

  it("answers a delivery route that is missing or not the caller's with its own code, never the unknown-endpoint one", async () => {
    const { RouteNotFoundError } = await import(
      "@/modules/route/usecases/errors/route-errors"
    );

    const error = new RouteNotFoundError();

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 404,
      code: "DELIVERY_ROUTE_NOT_FOUND",
    });
  });

  it("answers another company's access profile exactly like a missing one", async () => {
    const [
      { UserProfileAccessNotFoundError },
      { UserProfileNotMatchBusinessError },
      { PermissionBusinessError },
    ] = await Promise.all([
      import(
        "@/modules/user/usecases/errors/user-profile-access-not-found-error"
      ),
      import(
        "@/modules/user/usecases/errors/user-profile-not-match-business-error"
      ),
      import("@/modules/permission/usecases/errors/permission-business-error"),
    ]);

    const missing = new UserProfileAccessNotFoundError();

    for (const foreign of [
      new UserProfileNotMatchBusinessError(),
      new PermissionBusinessError(),
    ]) {
      expect(foreign).toMatchObject({
        statusCode: missing.statusCode,
        code: missing.code,
        message: missing.message,
      });
    }
  });
});
