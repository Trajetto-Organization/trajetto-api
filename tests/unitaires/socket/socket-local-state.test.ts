import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * No per-replica bookkeeping of who is connected.
 *
 * `connectedUsers` was a map of user → socket ids that the server wrote on
 * every connect and disconnect and nothing ever read. With N replicas it only
 * ever held this replica's sockets, so the first feature to ask it "is this
 * user online?" — or "send a push if they are not" — would be wrong about
 * (N-1)/N of the time. Presence is the adapter's answer (`getOnlineUserIds`),
 * and a per-replica count, when one is needed, is the local adapter's own room
 * index, which cleans itself up.
 */
const source = readFileSync(
  resolve(process.cwd(), "src/websocket.ts"),
  "utf8",
);

describe("the socket server's local state", () => {
  it("keeps no map of connected users", () => {
    expect(source).not.toMatch(/connectedUsers/);
  });
});
