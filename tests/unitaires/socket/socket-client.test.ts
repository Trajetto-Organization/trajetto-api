import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SOCKET_CLIENT_HEADER,
  joinsOwnDispatchRoomsOnConnect,
  mayLeaveOwnDispatchRooms,
  socketClientOf,
} from "@/shared/socket/socket-client";

/**
 * The app's socket joins the dispatch rooms only when a screen asks (wave 4).
 *
 * Every admin or operator with the app open was put in the company's
 * operations and SAC rooms at connect and received the whole fleet's
 * positions, route events and chat, which the app discarded. The rule that
 * tells the app from the web is pure and lives here;
 * `socket-mobile-rooms.test.ts` proves the rooms through the real channel.
 */
describe("which client a handshake declares", () => {
  it("is the app when the header says mobile, as on every HTTP request", () => {
    expect(SOCKET_CLIENT_HEADER).toBe("x-trajetto-client");
    expect(socketClientOf({ headers: { "x-trajetto-client": "mobile" } })).toBe(
      "mobile",
    );
  });

  it("is the app when the handshake payload says so", () => {
    expect(socketClientOf({ auth: { token: "t", client: "mobile" } })).toBe(
      "mobile",
    );
  });

  it("is the web when nothing is said, which is every build before wave 4", () => {
    // An old app build keeps the auto-join: it discards those events today,
    // so the only cost is the one it already had.
    expect(socketClientOf({ headers: {}, auth: { token: "t" } })).toBe("web");
    expect(socketClientOf({})).toBe("web");
  });

  it("reads only the exact value, like the HTTP header", () => {
    expect(socketClientOf({ headers: { "x-trajetto-client": "web" } })).toBe(
      "web",
    );
    expect(socketClientOf({ headers: { "x-trajetto-client": "Mobile" } })).toBe(
      "web",
    );
    expect(
      socketClientOf({ headers: { "x-trajetto-client": ["mobile", "web"] } }),
    ).toBe("web");
    expect(socketClientOf({ auth: { client: "MOBILE" } })).toBe("web");
  });

  it("ignores a payload that is not an object", () => {
    expect(socketClientOf({ auth: "mobile" })).toBe("web");
    expect(socketClientOf({ auth: null })).toBe("web");
  });
});

describe("what the declaration changes", () => {
  it("joins the own company's dispatch rooms at connect only on the web", () => {
    expect(joinsOwnDispatchRoomsOnConnect("web")).toBe(true);
    expect(joinsOwnDispatchRoomsOnConnect("mobile")).toBe(false);

    // A socket that predates the field is a web one.
    expect(joinsOwnDispatchRoomsOnConnect(undefined)).toBe(true);
  });

  it("lets only the app leave its own company's room", () => {
    // The web's lock stays: the room it got at connect feeds the panel.
    expect(mayLeaveOwnDispatchRooms("web")).toBe(false);
    expect(mayLeaveOwnDispatchRooms(undefined)).toBe(false);
    expect(mayLeaveOwnDispatchRooms("mobile")).toBe(true);
  });
});

describe("the socket server wires the rule where the rooms are decided", () => {
  // The handshake reads the database, so the rooms themselves are proved in
  // the E2E suite; this keeps the cheap suite failing first if a join or a
  // lock is edited back to ignoring the client.
  const source = readFileSync(
    resolve(process.cwd(), "src/websocket.ts"),
    "utf8",
  );

  it("classifies the socket at the handshake", () => {
    // Since plano-escala U-01 the upgrade's request is let go at the
    // engine's connection, so the marker header comes from what the engine
    // kept of it; the handshake payload still counts.
    expect(source).toMatch(
      /socket\.data\.client = socketClientOf\(\{\s*headers: engineAttempt\s*\? \{ \[SOCKET_CLIENT_HEADER\]: engineAttempt\.clientHeader \}\s*: socket\.handshake\.headers,\s*auth: socket\.handshake\.auth,/,
    );
    expect(source).toMatch(
      /clientHeader: request\?\.headers\?\.\[SOCKET_CLIENT_HEADER\],\s*\}\);\s*raw\.request = null;/,
    );
  });

  it("gates both auto-joins on the client", () => {
    const gated = source.match(
      /socket\.data\.isDeliveryStaff && businessId && joinsOwnDispatchRooms/g,
    );

    expect(gated).toHaveLength(2);
  });

  it("lifts both own-company locks only for the client that may leave", () => {
    const lifted = source.match(
      /requestedBusinessId === socket\.data\.businessId &&\s*!mayLeaveOwnDispatchRooms\(socket\.data\.client\)/g,
    );

    expect(lifted).toHaveLength(2);
  });
});
