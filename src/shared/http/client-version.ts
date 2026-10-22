import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Which build of the driver's app is calling.
 *
 * The app and this API deploy on their own schedules, and an app build stays
 * in drivers' hands for as long as they do not update it — its outbox can
 * hold a submission for days on top of that. Until this header, the API could
 * not say which builds were still calling, so nobody could tell when an old
 * contract was safe to remove, nor stop a build that had become harmful.
 *
 * Sent by every build from this one on, as `x-trajetto-client-version`:
 *
 *   platform=android; version=1.4.0; build=42; runtime=<fingerprint>;
 *   update=<update id | embedded>; contract=1; outbox=1
 *
 * `contract` is the one the gate reads: a number the app's JavaScript carries
 * and raises whenever a release changes what it sends. It travels with an
 * over-the-air update, so a fix shipped that way lifts the gate for every
 * phone that took it; a phone whose binary cannot take the update keeps the
 * old number and is sent to the store. `build` is the native build number
 * when the phone can tell — informative only, since EAS assigns it remotely.
 *
 * Separate from `x-trajetto-client: mobile`, which picks the app's refresh
 * policy and is compared as an exact value. A build that sends neither — the
 * one in drivers' hands today, or the web — is simply not described.
 */
const CLIENT_VERSION_HEADER = "x-trajetto-client-version";

interface ClientVersion {
  platform?: string;
  version?: string;
  build?: number;
  runtime?: string;
  update?: string;
  contract?: number;
  outbox?: number;
}

const MAX_HEADER_LENGTH = 512;

/** Null when the header is absent or says nothing this API understands. */
function parseClientVersion(header: unknown): ClientVersion | null {
  if (typeof header !== "string" || header.length > MAX_HEADER_LENGTH) {
    return null;
  }

  const client: ClientVersion = {};

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    const key = pair.slice(0, separator).trim();
    const value = pair
      .slice(separator + 1)
      .trim()
      .slice(0, 128);

    if (!value) continue;

    if (key === "build" || key === "contract" || key === "outbox") {
      if (/^\d{1,9}$/.test(value)) client[key] = Number(value);
    } else if (
      key === "platform" ||
      key === "version" ||
      key === "runtime" ||
      key === "update"
    ) {
      client[key] = value;
    }
  }

  return Object.keys(client).length > 0 ? client : null;
}

/**
 * The raw header, bounded, for a log line. On every request line (see
 * request-log-serializer), not only on refusals: which builds still call a
 * contract is read from there before MIN_MOBILE_CONTRACT is raised.
 */
function clientVersionForLog(request: FastifyRequest): string | undefined {
  const header = request.headers?.[CLIENT_VERSION_HEADER];

  return typeof header === "string"
    ? header.slice(0, MAX_HEADER_LENGTH)
    : undefined;
}

/**
 * What an outdated build may still do: keep its session and end it. Turning
 * those away too would leave a driver unable even to sign out, and a refresh
 * refused with 426 would look to the app like any other failure.
 */
const UPGRADE_EXEMPT_ROUTES = new Set([
  "POST /user/session",
  "POST /user/two-factor-verification",
  "POST /user/refresh-token",
  "POST /user/logout",
]);

/** Shared with the OpenAPI transform, which documents the 426 elsewhere. */
function isUpgradeExempt(
  method: string,
  routeUrl: string | undefined,
): boolean {
  return UPGRADE_EXEMPT_ROUTES.has(`${method} ${routeUrl}`);
}

/**
 * Turns away app builds whose `contract` is below `minContract`, with 426
 * CLIENT_UPGRADE_REQUIRED.
 *
 * Off unless MIN_MOBILE_CONTRACT is set. Applies ONLY to a request that says
 * which contract it speaks: a client without the header — the web, and every
 * build from before the header existed — is never refused here, whatever the
 * minimum. The app files a 426 as a contract failure: the item stays on the
 * phone, visible, and is sent again by itself once the app is updated.
 *
 * `storeUrl` (MOBILE_STORE_URL) goes in the body when set: the page the app
 * opens when no over-the-air update for its runtime exists. Kept in the API
 * so the link can change without a new app build; absent, the field is left
 * out and the app falls back to the store page it works out for itself.
 */
function clientUpgradeGate(minContract: number | undefined, storeUrl?: string) {
  return async function clientUpgradeGateHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!minContract) return;

    const client = parseClientVersion(request.headers[CLIENT_VERSION_HEADER]);

    if (client?.contract === undefined || client.contract >= minContract) {
      return;
    }

    if (isUpgradeExempt(request.method, request.routeOptions.url)) {
      return;
    }

    request.log.warn(
      { client: clientVersionForLog(request), minContract },
      "Client upgrade required",
    );

    // Serialized here, like every error body, so no route schema strips it.
    return reply
      .status(426)
      .header("x-error-code", "CLIENT_UPGRADE_REQUIRED")
      .type("application/json; charset=utf-8")
      .send(
        JSON.stringify({
          code: "CLIENT_UPGRADE_REQUIRED",
          message:
            "Esta versão do aplicativo não é mais aceita. Atualize o aplicativo Trajetto para continuar — o que estiver na fila de envio continua salvo.",
          minContract,
          ...(storeUrl ? { storeUrl } : {}),
        }),
      );
  };
}

export {
  CLIENT_VERSION_HEADER,
  clientUpgradeGate,
  clientVersionForLog,
  isUpgradeExempt,
  parseClientVersion,
};
export type { ClientVersion };
