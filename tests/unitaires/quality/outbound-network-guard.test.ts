import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configuredHosts,
  isLoopback,
  takeBlockedConnections,
  targetOf,
} from "../../support/outbound-network-guard";

/**
 * The guard setupTests.ts installs in every test file: no connection leaves
 * the machine (CI audit, decision D7). Ethereal is the case that made it a
 * check — E2E runs created accounts at api.nodemailer.com and talked SMTP to
 * smtp.ethereal.email, and no test said so. These cases run with the guard
 * the suite runs with, so they prove the installed one, not a copy.
 */
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function connect(options: net.NetConnectOpts): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(options);

    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve(`${error.code}: ${error.message}`),
    );
  });
}

describe("a test's connections", () => {
  it("reach the loopback", async () => {
    expect(await connect({ host: "127.0.0.1", port })).toBe("connected");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect(takeBlockedConnections()).toEqual([]);
  });

  it("are refused anywhere else, before any DNS lookup, and remembered for the file", async () => {
    const outcome = await connect({ host: "smtp.ethereal.email", port: 587 });

    expect(outcome).toMatch(/^ECONNREFUSED: .*smtp\.ethereal\.email:587/);
    await expect(fetch("https://api.nodemailer.com/user")).rejects.toThrow();

    // Taken here so this file's own check stays green: these were on purpose.
    expect(takeBlockedConnections()).toEqual([
      "smtp.ethereal.email:587",
      "api.nodemailer.com:443",
    ]);
  });
});

describe("a connection whose caller resolves the name itself", () => {
  /**
   * The webhook client hands the socket the address its own lookup
   * validated, and webhook-dns-rebinding.test.ts answers that lookup with a
   * local address under a made-up name. Refusing by the name would have
   * stopped the product's own check from ever running.
   */
  /** Answers both shapes Node asks for (`all: true` since autoSelectFamily). */
  function lookupAnswering(address: string) {
    return (
      _hostname: string,
      options: { all?: boolean },
      callback: (error: null, answer: unknown, family?: number) => void,
    ) =>
      options?.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4);
  }

  it("goes through when that lookup answers the loopback", async () => {
    const outcome = await connect({
      host: "receptor.exemplo.com.br",
      port,
      lookup: lookupAnswering("127.0.0.1") as never,
    });

    expect(outcome).toBe("connected");
    expect(takeBlockedConnections()).toEqual([]);
  });

  it("is refused when that lookup answers an outside address", async () => {
    const outcome = await connect({
      host: "receptor.exemplo.com.br",
      port,
      lookup: lookupAnswering("203.0.113.9") as never,
    });

    expect(outcome).toMatch(/^ECONNREFUSED: .*203\.0\.113\.9/);
    expect(takeBlockedConnections()).toEqual([
      `receptor.exemplo.com.br (203.0.113.9):${port}`,
    ]);
  });
});

describe("what counts as this machine", () => {
  it("is the loopback, by name or address", () => {
    const loopback = [
      "localhost",
      "127.0.0.1",
      "127.8.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ];
    const elsewhere = ["10.0.0.5", "192.168.0.10", "example.com", "240.0.0.1"];

    for (const host of loopback) {
      expect(isLoopback(host), host).toBe(true);
    }

    for (const host of elsewhere) {
      expect(isLoopback(host), host).toBe(false);
    }
  });

  it("includes the database hosts the run was given", () => {
    const hosts = configuredHosts({
      DATABASE_URL: "postgresql://u:p@postgres:5432/db",
      REDIS_URL: "redis://cache:6379",
      REDIS_HOST: "cache-2",
      AI_LOCAL_URL: "http://[fd00::1]:8080",
    });

    expect([...hosts].sort()).toEqual([
      "cache",
      "cache-2",
      "fd00::1",
      "postgres",
    ]);
  });

  it("reads every shape a connect call takes, and leaves pipes alone", () => {
    expect(targetOf([[{ host: "db", port: 5432 }, () => {}]])).toEqual({
      host: "db",
      port: 5432,
    });
    expect(targetOf([{ port: 80 }])).toEqual({ host: "localhost", port: 80 });
    expect(targetOf([443, "example.com"])).toEqual({
      host: "example.com",
      port: 443,
    });
    expect(targetOf([{ path: "/tmp/.s.PGSQL.5432" }])).toBeNull();
    expect(targetOf(["\\\\.\\pipe\\docker_engine"])).toBeNull();
  });
});
