import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Emitter } from "@socket.io/redis-emitter";
import { describe, expect, it } from "vitest";

import {
  ADOPT_SESSION_VERSION_EVENT,
  MESSAGE_VERSIONS,
  REFRESH_DELIVERY_ROOMS_EVENT,
  WHATSAPP_TEMPLATE_LANE_EVENT,
  adoptSessionVersionMessage,
  readAdoptSessionVersion,
  readRefreshDeliveryRooms,
  readTemplateLaneFrame,
  refreshDeliveryRoomsArgs,
  templateLaneFrame,
} from "@/shared/socket/messages";
import { parseWakeMessage } from "@/shared/wake/wake-bus";
import { parseLaneMessage } from "@/shared/providers/whatsapp-provider/template-lane-bus";

/**
 * The messages between processes, versioned (plano-escala F3-31c, the
 * security review of the plan).
 *
 * The realtime role is deployed only when what it runs changes, so it may
 * run an older build than the processes that talk to it, and during any
 * rolling deploy the image of before talks to the new one. A message whose
 * shape moved under an older reader fails in silence: a revocation an
 * older realtime does not understand leaves a socket open. So:
 *
 *  - each message's shape is pinned here to its version: changing one
 *    without bumping MESSAGE_VERSIONS fails, and the bump moves the
 *    contract epoch, which deploys the realtime with that release;
 *  - the current code reads the previous version (the frames before `v`
 *    existed) and a newer one that only added fields;
 *  - the emitter of a process without sockets speaks the adapter's request
 *    protocol, for the server-side events and the revocations by room.
 */

/** Each message, as this version writes it: its version and its keys. */
const PINNED: Record<
  keyof typeof MESSAGE_VERSIONS,
  { version: number; keys: string[] }
> = {
  "adopt-session-version": { version: 1, keys: ["sessionId", "v", "version"] },
  "refresh-delivery-rooms": { version: 1, keys: ["0:string", "1:v"] },
  "whatsapp-template-lane": {
    version: 1,
    keys: ["action", "seconds", "template", "v"],
  },
  "template-lane-channel": { version: 1, keys: ["change", "replica", "v"] },
  wake: { version: 1, keys: ["replica", "v"] },
};

const sorted = (value: object) => Object.keys(value).sort();

/** What each message looks like now, written by the code that sends it. */
function shapes(): Record<keyof typeof MESSAGE_VERSIONS, string[]> {
  const [businessId, meta] = refreshDeliveryRoomsArgs("b-1");

  return {
    "adopt-session-version": sorted(adoptSessionVersionMessage("s-1", 3)),
    "refresh-delivery-rooms": [
      `0:${typeof businessId}`,
      ...sorted(meta).map((key) => `1:${key}`),
    ],
    "whatsapp-template-lane": sorted(
      templateLaneFrame({ template: "t", action: "pause", seconds: 60 }),
    ),
    // The lane's channel and the wake write JSON with these keys
    // (template-lane-bus.ts, wake-bus.ts; their own tests check the bytes).
    "template-lane-channel": ["change", "replica", "v"],
    wake: ["replica", "v"],
  };
}

describe("every message between processes", () => {
  it("has the shape pinned to its version: a change bumps MESSAGE_VERSIONS", () => {
    const now = shapes();

    for (const name of Object.keys(PINNED) as Array<
      keyof typeof MESSAGE_VERSIONS
    >) {
      expect(MESSAGE_VERSIONS[name], `${name}: versão`).toBe(
        PINNED[name].version,
      );
      expect(now[name], `${name}: mudou sem subir a versão`).toEqual(
        PINNED[name].keys,
      );
    }

    expect(Object.keys(MESSAGE_VERSIONS).sort()).toEqual(
      Object.keys(PINNED).sort(),
    );
  });

  it("is in the contract epoch the image is labelled with", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(process.cwd(), ".github/scripts/realtime-closure.mjs"),
        "--epoch",
      ],
      { encoding: "utf8" },
    );
    const contracts = spawnSync(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");const d="prisma/migrations";console.log(fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(d+"/"+e.name+"/migration.sql")&&/--\\s*contract-phase:/.test(fs.readFileSync(d+"/"+e.name+"/migration.sql","utf8"))).length)`,
      ],
      { encoding: "utf8" },
    );

    const versions = Object.values(MESSAGE_VERSIONS).reduce(
      (total: number, version: number) => total + version,
      0,
    );

    expect(Number(result.stdout)).toBe(versions + Number(contracts.stdout));
  });
});

describe("the current code reads the version before its own", () => {
  it("adopt-session-version: without `v`, with it, and newer with more fields", () => {
    const expected = { sessionId: "s-1", version: 4 };

    expect(readAdoptSessionVersion({ sessionId: "s-1", version: 4 })).toEqual(
      expected,
    );
    expect(
      readAdoptSessionVersion(adoptSessionVersionMessage("s-1", 4)),
    ).toEqual(expected);
    expect(
      readAdoptSessionVersion({ v: 9, sessionId: "s-1", version: 4, extra: 1 }),
    ).toEqual(expected);

    for (const garbage of [
      null,
      "s-1",
      { sessionId: "s-1" },
      { sessionId: 1, version: 4 },
      { v: "1", sessionId: "s-1", version: 4 },
      { v: -1, sessionId: "s-1", version: 4 },
    ]) {
      expect(
        readAdoptSessionVersion(garbage),
        JSON.stringify(garbage),
      ).toBeNull();
    }
  });

  it("refresh-delivery-rooms: the bare company of before, and the company with `{ v }`", () => {
    expect(readRefreshDeliveryRooms("b-1")).toBe("b-1");
    expect(readRefreshDeliveryRooms(...refreshDeliveryRoomsArgs("b-1"))).toBe(
      "b-1",
    );
    expect(readRefreshDeliveryRooms("b-1", { v: 7, extra: true })).toBe("b-1");

    expect(readRefreshDeliveryRooms(42)).toBeNull();
    expect(readRefreshDeliveryRooms("")).toBeNull();
    expect(readRefreshDeliveryRooms("b-1", { v: "x" })).toBeNull();
  });

  it("whatsapp-template-lane: the bare change of before, and the change with `v`", () => {
    const change = { template: "t", action: "pause", seconds: 60 };

    expect(readTemplateLaneFrame(change)).toEqual(change);
    expect(readTemplateLaneFrame(templateLaneFrame(change))).toEqual(change);
    expect(readTemplateLaneFrame(null)).toBeNull();
    expect(readTemplateLaneFrame({ ...change, v: -2 })).toBeNull();
  });

  it("the lane's channel and the wake: their first version, and a newer one", () => {
    const change = { template: "t", action: "resume" };

    expect(
      parseLaneMessage(JSON.stringify({ v: 1, replica: "r", change })),
    ).toMatchObject({ change });
    expect(
      parseLaneMessage(JSON.stringify({ v: 2, replica: "r", change, x: 1 })),
    ).toMatchObject({ change });
    expect(parseWakeMessage(JSON.stringify({ v: 1, replica: "r" }))).toEqual({
      v: 1,
      replica: "r",
    });
    expect(
      parseWakeMessage(JSON.stringify({ v: 2, replica: "r", extra: 1 })),
    ).toEqual({ v: 2, replica: "r" });
  });

  it("the image of before still reads what this one writes", () => {
    // What the code before F3-31c checked on each frame, verbatim.
    const before = {
      adopt: (frame: unknown) => {
        const { sessionId, version } = (frame ?? {}) as Record<string, unknown>;
        return typeof sessionId === "string" && Number.isInteger(version);
      },
      refresh: (businessId: unknown) => typeof businessId === "string",
      lane: (change: unknown) => {
        const { template, action } = (change ?? {}) as Record<string, unknown>;
        return (
          typeof template === "string" &&
          (action === "pause" || action === "resume")
        );
      },
    };

    expect(before.adopt(adoptSessionVersionMessage("s-1", 2))).toBe(true);
    expect(before.refresh(refreshDeliveryRoomsArgs("b-1")[0])).toBe(true);
    expect(
      before.lane(
        templateLaneFrame({ template: "t", action: "pause", seconds: 1 }),
      ),
    ).toBe(true);
  });
});

describe("the emitter of a process without sockets", () => {
  /** A Redis that records what the emitter publishes. */
  function emitter() {
    const published: Array<{ channel: string; message: string | Buffer }> = [];
    const client = {
      publish: (channel: string, message: string | Buffer) => {
        published.push({ channel, message });
        return Promise.resolve(1);
      },
    };

    return {
      published,
      emitter: new Emitter(client as never, { key: "socket.io" }),
    };
  }

  const ADAPTER = readFileSync(
    resolve(
      process.cwd(),
      "node_modules/@socket.io/redis-adapter/dist/index.js",
    ),
    "utf8",
  );

  /** The adapter's request type of that name, from its own code. */
  const requestType = (name: string) =>
    Number(
      new RegExp(`RequestType\\["${name}"\\] = (\\d+)`).exec(ADAPTER)?.[1],
    );

  it("sends a server-side event as the adapter's SERVER_SIDE_EMIT request, args in order", () => {
    const { emitter: out, published } = emitter();

    out.serverSideEmit(
      REFRESH_DELIVERY_ROOMS_EVENT,
      ...refreshDeliveryRoomsArgs("b-1"),
    );
    out.serverSideEmit(
      ADOPT_SESSION_VERSION_EVENT,
      adoptSessionVersionMessage("s-1", 2),
    );
    out.serverSideEmit(
      WHATSAPP_TEMPLATE_LANE_EVENT,
      templateLaneFrame({ template: "t", action: "resume" }),
    );

    expect(published.map((entry) => entry.channel)).toEqual([
      "socket.io-request#/#",
      "socket.io-request#/#",
      "socket.io-request#/#",
    ]);

    const [refresh] = published.map((entry) =>
      JSON.parse(String(entry.message)),
    );

    expect(refresh.type).toBe(requestType("SERVER_SIDE_EMIT"));
    expect(refresh.data).toEqual([
      REFRESH_DELIVERY_ROOMS_EVENT,
      "b-1",
      { v: MESSAGE_VERSIONS["refresh-delivery-rooms"] },
    ]);
    // Never mistaken for an adapter's own frame coming back to it.
    expect(refresh.uid).toBe("emitter");
  });

  it("ends the sessions of a room as the adapter's REMOTE_DISCONNECT request", () => {
    const { emitter: out, published } = emitter();

    out.in("user:u-1").disconnectSockets(true);

    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe("socket.io-request#/#");
    expect(JSON.parse(String(published[0].message))).toEqual({
      type: requestType("REMOTE_DISCONNECT"),
      opts: { rooms: ["user:u-1"], except: [] },
      close: true,
    });
  });
});
