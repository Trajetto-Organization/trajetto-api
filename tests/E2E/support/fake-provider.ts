import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Every outside party the workers talk to, as one HTTP server in the test's
 * process: Meta (WhatsApp), Expo (push), Resend (e-mail, through the replica's
 * forwarding mail provider), the customers' webhook receivers and the local
 * OCR service.
 *
 * It lives in the TEST process on purpose. The replicas under test are other
 * processes (pipeline-replica.ts) and can be killed at any instant; what the
 * provider "accepted" must survive them, exactly like a real provider's
 * record survives our crash. Every request is recorded BEFORE it is answered,
 * so a request held open and then orphaned by a SIGKILL still counts as
 * accepted — case A of contract §11.
 */
type ProviderKind = "email" | "whatsapp" | "push" | "webhook" | "ocr";

interface ProviderCall {
  kind: ProviderKind;
  /** What a real provider would dedupe or reconcile the call by. */
  identity: string;
  /** The idempotency key the call carried, when the provider honours one. */
  idempotencyKey: string | null;
  headers: IncomingMessage["headers"];
  body: unknown;
  at: number;
  /** The pid of the replica that made the call (pipeline-replica.ts tags it). */
  replica: string | null;
}

/** Decides, per call, how the provider answers. */
type Behaviour =
  | { kind: "answer" }
  | { kind: "delay"; ms: number }
  // Recorded, then never answered until released: the call the provider
  // accepted while we died waiting for the answer.
  | { kind: "hold" }
  | { kind: "status"; status: number; body?: unknown };

class FakeProvider {
  readonly calls: ProviderCall[] = [];

  private server: Server;
  private held: Array<() => void> = [];
  private sequence = 0;

  /** Per kind; the default answers at once with a success. */
  private behaviours = new Map<
    ProviderKind,
    (call: ProviderCall) => Behaviour
  >();

  url = "";

  constructor() {
    this.server = createServer((request, response) =>
      this.handle(request, response),
    );
  }

  async listen(): Promise<string> {
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;

    return this.url;
  }

  behave(kind: ProviderKind, decide: (call: ProviderCall) => Behaviour): void {
    this.behaviours.set(kind, decide);
  }

  reset(): void {
    this.calls.length = 0;
    this.behaviours.clear();
    this.releaseHeld();
  }

  /** Answers every held call (their callers may be dead already). */
  releaseHeld(): void {
    const held = this.held;
    this.held = [];

    for (const release of held) release();
  }

  callsOf(kind: ProviderKind): ProviderCall[] {
    return this.calls.filter((call) => call.kind === kind);
  }

  /** The distinct replicas that served calls of these kinds. */
  replicasServing(...kinds: ProviderKind[]): Set<string> {
    return new Set(
      this.calls
        .filter((call) => kinds.length === 0 || kinds.includes(call.kind))
        .map((call) => call.replica)
        .filter((replica): replica is string => replica !== null),
    );
  }

  /** Identities seen more than once: what a recipient would get twice. */
  repeated(kind: ProviderKind): string[] {
    const seen = new Map<string, number>();

    for (const call of this.callsOf(kind)) {
      seen.set(call.identity, (seen.get(call.identity) ?? 0) + 1);
    }

    return [...seen]
      .filter(([, count]) => count > 1)
      .map(([identity]) => identity);
  }

  async waitFor(
    predicate: () => boolean,
    what: string,
    timeoutMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`tempo esgotado esperando: ${what}`);

      await new Promise((done) => setTimeout(done, 50));
    }
  }

  async close(): Promise<void> {
    this.releaseHeld();
    this.server.closeAllConnections();

    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = request.url ?? "/";
      const kind = kindOf(path);

      let body: unknown = null;

      if (kind !== "ocr") {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          body = raw.toString("utf8");
        }
      }

      const call: ProviderCall = {
        kind,
        identity: identityOf(kind, request, body, raw),
        idempotencyKey: idempotencyKeyOf(kind, request, body),
        headers: request.headers,
        body,
        at: Date.now(),
        replica:
          typeof request.headers["x-replica-pid"] === "string"
            ? request.headers["x-replica-pid"]
            : null,
      };

      // Recorded before any answer: "accepted" is the provider's fact, and it
      // must not depend on the caller living long enough to read the reply.
      this.calls.push(call);

      const behaviour = this.behaviours.get(kind)?.(call) ?? { kind: "answer" };
      const answer = () => this.answer(kind, call, response);

      if (behaviour.kind === "hold") {
        this.held.push(() => {
          if (!response.destroyed) answer();
        });
        return;
      }

      if (behaviour.kind === "delay") {
        setTimeout(() => {
          if (!response.destroyed) answer();
        }, behaviour.ms);
        return;
      }

      if (behaviour.kind === "status") {
        response.writeHead(behaviour.status, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(behaviour.body ?? { error: "fake failure" }),
        );
        return;
      }

      answer();
    });
  }

  private answer(
    kind: ProviderKind,
    call: ProviderCall,
    response: ServerResponse,
  ): void {
    this.sequence += 1;

    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };

    switch (kind) {
      case "whatsapp":
        json({
          messaging_product: "whatsapp",
          messages: [{ id: `wamid.fake-${this.sequence}` }],
        });
        return;
      case "push": {
        const messages = Array.isArray(call.body) ? call.body : [];

        json({
          data: messages.map((_, index) => ({
            status: "ok",
            id: `ticket-${this.sequence}-${index}`,
          })),
        });
        return;
      }
      case "email":
        json({ messageId: `<fake-${this.sequence}@resend.test>` });
        return;
      case "ocr":
        // An odometer that reads 1000: what the queued fuelings declare.
        json({
          lines: [
            {
              text: "001000",
              score: 0.99,
              box: [
                [0, 0],
                [10, 0],
                [10, 5],
                [0, 5],
              ],
            },
          ],
          engine: "fake",
          engineVersion: "0",
        });
        return;
      default:
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
    }
  }
}

function kindOf(path: string): ProviderKind {
  if (path.startsWith("/email")) return "email";
  if (path.startsWith("/--/api/v2/push")) return "push";
  if (path.startsWith("/v1/read")) return "ocr";
  if (path.startsWith("/hook")) return "webhook";

  // graph.facebook.com/<version>/<phone id>/messages, rewritten here.
  return "whatsapp";
}

function identityOf(
  kind: ProviderKind,
  request: IncomingMessage,
  body: unknown,
  raw: Buffer,
): string {
  const record = (body ?? {}) as Record<string, unknown>;

  switch (kind) {
    case "email":
      return String(record.referenceId ?? "");
    case "whatsapp":
      // The delivery id Meta echoes back on every status callback.
      return String(record.biz_opaque_callback_data ?? "");
    case "push": {
      const first = (Array.isArray(body) ? body[0] : {}) as {
        data?: { deliveryId?: string };
      };

      return String(first?.data?.deliveryId ?? "");
    }
    case "webhook":
      return `${request.url}|${String(request.headers["x-trajetto-event-id"] ?? "")}`;
    default:
      return raw.toString("utf8");
  }
}

function idempotencyKeyOf(
  kind: ProviderKind,
  request: IncomingMessage,
  body: unknown,
): string | null {
  if (kind === "email") {
    const header = request.headers["resend-idempotency-key"];

    return typeof header === "string" ? header : null;
  }

  // Meta and Expo offer no idempotency key: what they get twice, they send
  // twice (ADR 0006).
  if (kind === "webhook") {
    const header = request.headers["x-trajetto-event-id"];

    return typeof header === "string" ? header : null;
  }

  void body;

  return null;
}

export { FakeProvider };
export type { Behaviour, ProviderCall, ProviderKind };
