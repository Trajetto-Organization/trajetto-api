import net from "node:net";

/**
 * A TCP proxy in front of the test Postgres that lets the first COMMIT reach
 * the server and then resets the client's connection instead of handing it
 * the answer: Postgres made the transaction durable, the client sees
 * ECONNRESET. That is a connection lost on the way back from a COMMIT — a
 * proxy or balancer recycling its upstream, a node going away — the case in
 * which a 503 cannot promise "not executed". Everything after the first reset
 * flows untouched.
 *
 * It reads the frontend's messages to know what the client sent: the startup
 * packet (no type byte), then typed messages. pg sends a statement without
 * parameters, the COMMIT of adapter-pg's transactions included, as a simple
 * query (`Q`). The connection must be plaintext, as the test URL is.
 */
class CommitResetProxy {
  private resetCount = 0;

  private readonly sockets = new Set<net.Socket>();

  private readonly server: net.Server;

  constructor(target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(target.port, target.host);

      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {});
      }

      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());

      let pending = Buffer.alloc(0);
      let startupDone = false;
      let commitSent = false;

      /** Whether the client's bytes so far end a simple-query COMMIT. */
      const sawCommit = (chunk: Buffer): boolean => {
        pending = Buffer.concat([pending, chunk]);

        for (;;) {
          if (!startupDone) {
            if (pending.length < 4) return false;

            const length = pending.readInt32BE(0);

            if (pending.length < length) return false;

            pending = pending.subarray(length);
            startupDone = true;
            continue;
          }

          if (pending.length < 5) return false;

          const type = String.fromCharCode(pending[0]);
          const length = pending.readInt32BE(1);

          if (pending.length < 1 + length) return false;

          const body = pending.subarray(5, 1 + length);
          pending = pending.subarray(1 + length);

          if (type !== "Q") continue;

          const sql = body.toString("utf8").replace(/\0+$/, "");

          if (/^\s*COMMIT\b/i.test(sql)) return true;
        }
      };

      client.on("data", (chunk: Buffer) => {
        if (this.resetCount === 0 && !commitSent && sawCommit(chunk)) {
          commitSent = true;
        }

        upstream.write(chunk);
      });

      upstream.on("data", (chunk: Buffer) => {
        if (commitSent && this.resetCount === 0) {
          // Postgres answered the COMMIT: it is durable. The answer never
          // reaches the client, whose connection is reset.
          this.resetCount += 1;
          client.resetAndDestroy();
          upstream.destroy();

          return;
        }

        client.write(chunk);
      });
    });
  }

  /** In front of the Postgres `databaseUrl` points at. */
  static for(databaseUrl: string): CommitResetProxy {
    const url = new URL(databaseUrl);

    return new CommitResetProxy({
      host: url.hostname,
      port: Number(url.port || 5432),
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));

    return (this.server.address() as net.AddressInfo).port;
  }

  /** How many connections were reset after their COMMIT ran. */
  get resets(): number {
    return this.resetCount;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();

    await new Promise<void>((done) => this.server.close(() => done()));
  }
}

export { CommitResetProxy };
