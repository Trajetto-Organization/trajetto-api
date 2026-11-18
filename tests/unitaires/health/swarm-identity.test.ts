import os from "node:os";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import { buildLogger } from "@/shared/logging/logger";
import {
  buildOpsSampleRow,
  createSampleSections,
  opsSampleIdentity,
  type OpsSampleWindow,
} from "@/shared/health/ops-sample";
import { swarmIdentityOf, swarmLogBindings } from "@/shared/swarm-identity";

/**
 * Which node, slot and service a process is, by the Swarm's own templates
 * (plano-escala F4-50).
 *
 * The container's hostname is all a log line or an ops_sample row said about
 * where it ran: a container id that changes on every deploy and says nothing
 * about the node. With more than one node (F4-52), "the replica that is slow"
 * has to name the machine. The Application's Environment takes
 * `SWARM_NODE_HOSTNAME={{.Node.Hostname}}`, `SWARM_TASK_SLOT={{.Task.Slot}}`
 * and `SWARM_SERVICE_NAME={{.Service.Name}}`, which the Swarm renders per
 * task. What this pins:
 *
 *  - all three are optional, and without them nothing changes: the log
 *    bindings and the row are exactly what they were;
 *  - a value still holding `{{` is a template nobody rendered (docker run,
 *    the dev compose) and counts as absent, as does an empty one;
 *  - a value that is not a plain name never stops the boot: it is a label,
 *    and a label is never worth a process that refuses to start.
 */

const BASE_ENV = {
  NODE_ENV: "test",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

function parse(overrides: Record<string, string>) {
  const parsed = envSchema.safeParse(definedEnv({ ...BASE_ENV, ...overrides }));

  if (!parsed.success) throw parsed.error;

  return parsed.data as unknown as {
    SWARM_NODE_HOSTNAME?: string;
    SWARM_TASK_SLOT?: string;
    SWARM_SERVICE_NAME?: string;
  };
}

describe("the Swarm identity variables", () => {
  it("are optional: absent, nothing is set", () => {
    const env = parse({});

    expect(env.SWARM_NODE_HOSTNAME).toBeUndefined();
    expect(env.SWARM_TASK_SLOT).toBeUndefined();
    expect(env.SWARM_SERVICE_NAME).toBeUndefined();
    expect(swarmIdentityOf(env)).toEqual({});
  });

  it("read what the Swarm rendered", () => {
    const env = parse({
      SWARM_NODE_HOSTNAME: "node-1",
      SWARM_TASK_SLOT: "2",
      SWARM_SERVICE_NAME: "trajetto-api-staging",
    });

    expect(swarmIdentityOf(env)).toEqual({
      node: "node-1",
      task_slot: "2",
      service: "trajetto-api-staging",
    });
  });

  it("count a template nobody rendered as absent", () => {
    const env = parse({
      SWARM_NODE_HOSTNAME: "{{.Node.Hostname}}",
      SWARM_TASK_SLOT: "{{.Task.Slot}}",
      SWARM_SERVICE_NAME: "{{.Service.Name}}",
    });

    expect(swarmIdentityOf(env)).toEqual({});
  });

  it("count an empty or blank value as absent", () => {
    const env = parse({
      SWARM_NODE_HOSTNAME: "",
      SWARM_TASK_SLOT: "   ",
      SWARM_SERVICE_NAME: "",
    });

    expect(swarmIdentityOf(env)).toEqual({});
  });

  it("trim what surrounds a value", () => {
    const env = parse({ SWARM_NODE_HOSTNAME: "  prod-1.example.com " });

    expect(swarmIdentityOf(env)).toEqual({ node: "prod-1.example.com" });
  });

  it("drop a value that is not a plain name instead of refusing the boot", () => {
    const env = parse({
      SWARM_NODE_HOSTNAME: "node one; rm -rf",
      SWARM_TASK_SLOT: "x".repeat(200),
      SWARM_SERVICE_NAME: "ok-service",
    });

    expect(swarmIdentityOf(env)).toEqual({ service: "ok-service" });
  });

  it("take the node id a global service renders in place of a slot", () => {
    const nodeId = "q8tf3j4w0xnvbkmyz1l2a5r6c";

    expect(swarmIdentityOf(parse({ SWARM_TASK_SLOT: nodeId }))).toEqual({
      task_slot: nodeId,
    });
  });
});

describe("the log bindings", () => {
  it("add nothing without the variables", () => {
    expect(swarmLogBindings({})).toEqual({});
  });

  it("name each part that is present", () => {
    const all = { node: "node-1", task_slot: "1", service: "api" };

    expect(swarmLogBindings(all)).toEqual({
      swarm_node: "node-1",
      swarm_task_slot: "1",
      swarm_service: "api",
    });
    expect(swarmLogBindings({ task_slot: "1" })).toEqual({
      swarm_task_slot: "1",
    });
  });

  it("leave the process's own line as it was without the variables", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });

    buildLogger(sink).info("x");

    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    const keys = Object.keys(line);

    expect(keys.filter((key) => key.startsWith("swarm"))).toEqual([]);
    expect(line.hostname).toBe(os.hostname());
  });
});

describe("the ops_sample identity", () => {
  it("is the hostname alone without the variables", () => {
    const identity = opsSampleIdentity("all", {});

    expect(identity.replica).toBe(os.hostname());
    expect(identity.swarm).toBeUndefined();
  });

  it("adds the slot to the replica and carries the parts", () => {
    const swarm = { node: "node-1", task_slot: "2", service: "api" };
    const identity = opsSampleIdentity("api", swarm);

    expect(identity.role).toBe("api");
    expect(identity.replica).toBe(`${os.hostname()}/2`);
    expect(identity.swarm).toEqual(swarm);
  });

  it("keeps the hostname alone when only the node is known", () => {
    const identity = opsSampleIdentity("all", { node: "node-1" });

    expect(identity.replica).toBe(os.hostname());
    expect(identity.swarm).toEqual({ node: "node-1" });
  });

  it("puts the parts in the row, and only when they are known", () => {
    const window = {
      endedAt: new Date("2026-11-15T12:01:00.000Z"),
      runtime: { replica: "h", window_seconds: 60 },
      providers: [],
    } as unknown as OpsSampleWindow;
    const swarm = { node: "node-1", task_slot: "2", service: "api" };

    const known = opsSampleIdentity("all", swarm);
    const unknown = opsSampleIdentity("all", {});

    const withSwarm = buildOpsSampleRow(window, known, {});
    const without = buildOpsSampleRow(window, unknown, {});

    expect(withSwarm.metrics.swarm).toEqual(swarm);
    expect(without.metrics).not.toHaveProperty("swarm");
  });

  it("keeps the name for the row: a section cannot take it", () => {
    const sections = createSampleSections();

    expect(() => sections.register("swarm", () => ({}))).toThrow();
  });
});
