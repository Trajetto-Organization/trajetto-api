import net from "node:net";

/**
 * A TCP proxy in front of the test Postgres that can drop the flows open
 * right now on the floor — silently, the way a peer that vanished does: no
 * FIN, no RST, the bytes just stop arriving. Flows opened afterwards work.
 *
 * That is what a lost node, a partition, or the Swarm VIP (IPVS) forgetting a
 * flow idle for 900 s looks like from the client (GAP6-4).
 */
class SilentProxy {
  private readonly flows: Array<{ client: net.Socket; upstream: net.Socket; forgotten: boolean }> =
    [];

  private readonly server: net.Server;

  constructor(target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(target.port, target.host);
      const flow = { client, upstream, forgotten: false };

      client.on("data", (bytes) => {
        if (!flow.forgotten) upstream.write(bytes);
      });
      upstream.on("data", (bytes) => {
        if (!flow.forgotten) client.write(bytes);
      });

      client.on("error", () => {});
      upstream.on("error", () => {});
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());

      this.flows.push(flow);
    });
  }

  /** In front of the Postgres `databaseUrl` points at. */
  static for(databaseUrl: string): SilentProxy {
    const url = new URL(databaseUrl);

    return new SilentProxy({ host: url.hostname, port: Number(url.port || 5432) });
  }

  async listen(): Promise<number> {
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));

    return (this.server.address() as net.AddressInfo).port;
  }

  forgetOpenFlows(): void {
    for (const flow of this.flows) flow.forgotten = true;
  }

  async close(): Promise<void> {
    for (const flow of this.flows) {
      flow.client.destroy();
      flow.upstream.destroy();
    }

    await new Promise<void>((done) => this.server.close(() => done()));
  }
}

type Outcome =
  | { kind: "answered"; ms: number; value: unknown }
  | { kind: "failed"; ms: number; error: unknown }
  | { kind: "still waiting"; ms: number };

/** How a promise ends, or that it had not ended after `capMs`. */
async function settle(promise: Promise<unknown>, capMs: number): Promise<Outcome> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  const outcome = await Promise.race<Outcome>([
    promise.then(
      (value) => ({ kind: "answered", ms: Date.now() - startedAt, value }),
      (error: unknown) => ({ kind: "failed", ms: Date.now() - startedAt, error }),
    ),
    new Promise<Outcome>((done) => {
      timer = setTimeout(() => done({ kind: "still waiting", ms: capMs }), capMs);
    }),
  ]);

  clearTimeout(timer);

  return outcome;
}

export { SilentProxy, settle, type Outcome };
