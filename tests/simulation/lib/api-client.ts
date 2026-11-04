import type { SimLog } from "./log";

/**
 * The simulation's HTTP client: one per actor (a phone, the dispatcher),
 * pinned to one replica, logging every call.
 *
 * - Bearer token with refresh before expiry and once on a 401, through the
 *   actor's own refresh (the phone's carries its deviceId, like the app's).
 * - 429/503 wait out Retry-After and try again, a few times at most: the
 *   simulator never hammers, and never raises a limit to pass.
 * - A status the caller did not plan for (`expect`) is logged as
 *   `unexpected` and thrown: every one is a finding.
 * - `offline` makes every call fail like a phone in a dead zone, without
 *   touching the network.
 */
interface ApiResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;

  /** Sends the bearer token (default true). */
  auth?: boolean;

  /** Non-2xx statuses that are a planned answer, not a failure. */
  expect?: number[];

  /** Read the body as NDJSON lines (the list endpoints). */
  ndjson?: boolean;

  timeoutMs?: number;
}

class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

/** The phone has no signal (or the replica is unreachable). */
class NetworkFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkFailure";
  }
}

interface Session {
  token: string;
  refreshToken: string;
}

const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;

/** The wait when a 429/503 says nothing usable: never an instant retry. */
const RETRY_AFTER_FALLBACK_MS = 2_000;
const RETRY_AFTER_CAP_MS = 60_000;

/**
 * A Retry-After header in ms, read as the app reads it (utils/api-error.ts
 * parseRetryAfter): delta-seconds or an HTTP-date, never negative. Capped
 * at a minute; absent or unreadable, the fallback — `Number(null)` is 0,
 * and a bare Number() here once retried a 429 without the header at once.
 */
function retryAfterMs(header: string | null, now: number = Date.now()): number {
  const value = header?.trim() ?? "";
  let ms: number | null = null;

  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else if (/[a-z]/i.test(value)) {
    const date = Date.parse(value);

    if (!Number.isNaN(date)) ms = Math.max(0, date - now);
  }

  return ms === null
    ? RETRY_AFTER_FALLBACK_MS
    : Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** The `exp` of a JWT, in ms; null when unreadable. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: number };

    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The path as logged: tokens in the query are never written down. */
function loggedPath(path: string): string {
  return path.replace(/([?&](token|qrToken)=)[^&]+/g, "$1…");
}

class ApiClient {
  session: Session | null = null;

  offline = false;

  /** Renews the session; set by the actor (phone or dispatcher). */
  refresher: ((session: Session) => Promise<Session | null>) | null = null;

  constructor(
    readonly baseUrl: string,
    readonly replica: string,
    readonly actor: string,
    private readonly log: SimLog,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  private async ensureFreshToken(): Promise<void> {
    if (!this.session || !this.refresher) return;

    const expiry = tokenExpiry(this.session.token);

    // The app refreshes a token about to lapse before using it (jwt.ts).
    if (expiry !== null && expiry - Date.now() < 30_000) {
      await this.refresh();
    }
  }

  async refresh(): Promise<boolean> {
    if (!this.session || !this.refresher) return false;

    const next = await this.refresher(this.session);

    if (next) this.session = next;

    return next !== null;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    if (this.offline) {
      throw new NetworkFailure("Sem conexão (simulada).");
    }

    const auth = options.auth ?? true;

    if (auth) await this.ensureFreshToken();

    let refreshed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const headers: Record<string, string> = {
        ...this.defaultHeaders,
        ...options.headers,
      };

      // Content-Type only with a body, like the app (Fastify refuses a JSON
      // content-type on an empty body).
      if (options.body !== undefined)
        headers["Content-Type"] = "application/json";
      if (auth && this.session)
        headers.Authorization = `Bearer ${this.session.token}`;

      const started = performance.now();
      let response: Response;

      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const latencyMs = Math.round(performance.now() - started);

        this.log.http({
          actor: this.actor,
          replica: this.replica,
          method,
          path: loggedPath(path),
          status: 0,
          latencyMs,
          unexpected: true,
          message: error instanceof Error ? error.message : String(error),
          attempt,
        });

        throw new NetworkFailure(
          `${method} ${path}: ${error instanceof Error ? error.message : error}`,
        );
      }

      const text = await response.text();
      const latencyMs = Math.round(performance.now() - started);

      let data: unknown = null;

      if (options.ndjson && response.ok) {
        data = text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown);
      } else if (text.length > 0) {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          data = text;
        }
      }

      const body = (data ?? {}) as { code?: string; message?: string };
      const code =
        (typeof body.code === "string" ? body.code : undefined) ??
        response.headers.get("x-error-code") ??
        undefined;

      const planned =
        response.ok || (options.expect ?? []).includes(response.status);

      // A 401 on an authenticated call: one refresh and one retry, as the app.
      if (response.status === 401 && auth && !refreshed && this.refresher) {
        this.log.http({
          actor: this.actor,
          replica: this.replica,
          method,
          path: loggedPath(path),
          status: response.status,
          latencyMs,
          code,
          attempt,
          message: "401: renovando a sessão",
        });

        refreshed = true;

        if (await this.refresh()) continue;
      }

      const backOff =
        (response.status === 429 || response.status === 503) && !planned;

      this.log.http({
        actor: this.actor,
        replica: this.replica,
        method,
        path: loggedPath(path),
        status: response.status,
        latencyMs,
        code,
        attempt,
        ...(!planned && {
          unexpected: true,
          message: typeof body.message === "string" ? body.message : undefined,
        }),
      });

      if (backOff && attempt < MAX_ATTEMPTS) {
        await new Promise((done) =>
          setTimeout(done, retryAfterMs(response.headers.get("retry-after"))),
        );
        continue;
      }

      if (!planned) {
        throw new ApiFailure(
          `${method} ${loggedPath(path)} → ${response.status} ${code ?? ""} ${body.message ?? ""}`.trim(),
          response.status,
          code,
          data,
        );
      }

      return {
        status: response.status,
        data: data as T,
        headers: response.headers,
      };
    }

    throw new Error("unreachable");
  }

  /** The presigned PUT straight to storage (the local stand-in in tests). */
  async putObject(
    uploadUrl: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    if (this.offline) throw new NetworkFailure("Sem conexão (simulada).");

    const started = performance.now();
    const url = new URL(uploadUrl);
    let status = 0;
    let message: string | undefined;

    try {
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      status = response.status;

      if (!response.ok) message = (await response.text()).slice(0, 300);
      else await response.arrayBuffer();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    this.log.http({
      actor: this.actor,
      replica: this.replica,
      method: "PUT",
      path: loggedPath(`${url.pathname}${url.search}`),
      status,
      latencyMs: Math.round(performance.now() - started),
      ...(!(status >= 200 && status < 300) && { unexpected: true, message }),
    });

    if (status === 0)
      throw new NetworkFailure(`PUT ${url.pathname}: ${message}`);

    if (!(status >= 200 && status < 300)) {
      throw new ApiFailure(
        `PUT ${url.pathname} → ${status}`,
        status,
        undefined,
        message,
      );
    }
  }
}

export {
  ApiClient,
  ApiFailure,
  NetworkFailure,
  loggedPath,
  retryAfterMs,
  tokenExpiry,
};
export type { ApiResponse, RequestOptions, Session };

/**
 * SIM_API_URLS as replicas: the dispatcher always on the first (replica A,
 * where the web's socket is), each driver pinned to one, dealt round-robin
 * so they split evenly.
 */
class ReplicaPool {
  private dealt = 0;

  constructor(readonly urls: string[]) {
    if (urls.length === 0) throw new Error("SIM_API_URLS vazio.");
  }

  /** "A", "B", "C"… in the order of SIM_API_URLS. */
  label(index: number): string {
    return String.fromCharCode(65 + index);
  }

  dispatcher(): { url: string; label: string } {
    return { url: this.urls[0], label: this.label(0) };
  }

  next(): { url: string; label: string } {
    const index = this.dealt % this.urls.length;

    this.dealt += 1;

    return { url: this.urls[index], label: this.label(index) };
  }
}

export { ReplicaPool };
