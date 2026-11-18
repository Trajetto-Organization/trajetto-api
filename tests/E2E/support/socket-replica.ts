// First, as in http.ts: this file is a process entry point of its own, and
// the socket layer loads repositories and services that tsyringe decorates.
import "reflect-metadata";

import { createServer } from "node:http";

import {
  getOnlineUserIds,
  initializeSocketIO,
  sendDriverPositionToBusiness,
  sendRouteEventToBusiness,
  sendSecurityEventToBusiness,
  sendSecurityEventToUser,
  shutdownSocketIO,
} from "@/websocket";

/**
 * One API replica, as a process of its own.
 *
 * Every socket test in this suite so far boots Socket.IO in the test's own
 * process, which measures exactly one node — and the one thing a Redis
 * adapter exists for is what happens between two. `io` and the adapter's
 * clients are module singletons, so a second node is a second PROCESS: there
 * is no in-process shortcut that would still be testing the thing.
 *
 * Talks over stdin/stdout because that is the least machinery that works:
 * a line in is "emit this", a line out is "done". Anything richer would be a
 * second network to debug when the first one is what is under test.
 *
 * Questions go the other way too: `members` answers which of THIS replica's
 * sockets are in a room (`MEMBERS <id> <json>`), read from its own room
 * index. The tests wait on that instead of sleeping while the replica reads
 * the database before a join or a leave. `online` asks the CLUSTER which of
 * these users are connected, through the adapter (`ONLINE <id> <json>`), and
 * `adapter` says how the replica's adapter was built (`ADAPTER <id> <json>`;
 * plano-escala F4-51).
 */
const port = Number(process.argv[2]);

interface Command {
  kind:
    | "routeEvent"
    | "driverPosition"

    // What an admin's edit on THIS replica fires; `payload` is the event.
    | "securityToBusiness"
    | "securityToUser"

    // Questions, not emits: `payload` is { id, room }, { id, userIds } and
    // { id }.
    | "members"
    | "online"
    | "adapter";
  businessId: string;
  payload: Record<string, unknown>;
}

let io: Awaited<ReturnType<typeof initializeSocketIO>> | null = null;

async function main(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });

  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));

  io = await initializeSocketIO(server);

  // The parent waits for this line before connecting anything.
  process.stdout.write(`READY ${port}\n`);

  let pending = "";

  process.stdin.on("data", (chunk) => {
    pending += String(chunk);

    for (;;) {
      const breakAt = pending.indexOf("\n");

      if (breakAt < 0) break;

      const line = pending.slice(0, breakAt).trim();
      pending = pending.slice(breakAt + 1);

      if (line) run(line);
    }
  });

  const stop = async () => {
    await shutdownSocketIO();
    await new Promise<void>((done) => server.close(() => done()));
    process.exit(0);
  };

  process.on("SIGTERM", () => void stop());
  process.stdin.on("end", () => void stop());
}

function run(line: string): void {
  const command = JSON.parse(line) as Command;

  if (command.kind === "members") {
    const members = [
      ...(io?.of("/").adapter.rooms.get(String(command.payload.room)) ?? []),
    ];

    process.stdout.write(
      `MEMBERS ${String(command.payload.id)} ${JSON.stringify(members)}\n`,
    );

    return;
  }

  if (command.kind === "online") {
    const userIds = (command.payload.userIds as string[]) ?? [];

    void getOnlineUserIds(userIds).then((online) =>
      process.stdout.write(
        `ONLINE ${String(command.payload.id)} ${JSON.stringify(online)}\n`,
      ),
    );

    return;
  }

  if (command.kind === "adapter") {
    const adapter = io?.of("/").adapter as unknown as {
      requestsTimeout?: number;
    };

    process.stdout.write(
      `ADAPTER ${String(command.payload.id)} ${JSON.stringify({
        requestsTimeout: adapter?.requestsTimeout ?? null,
      })}\n`,
    );

    return;
  }

  if (command.kind === "routeEvent") {
    sendRouteEventToBusiness(command.businessId, command.payload as never);
  } else if (command.kind === "securityToBusiness") {
    sendSecurityEventToBusiness(command.businessId, {
      reason: String(command.payload.reason),
    });
  } else if (command.kind === "securityToUser") {
    sendSecurityEventToUser(String(command.payload.userId), {
      reason: String(command.payload.reason),
    });
  } else {
    sendDriverPositionToBusiness(command.businessId, command.payload as never);
  }

  process.stdout.write(`SENT ${command.kind}\n`);
}

void main();
