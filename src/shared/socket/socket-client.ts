/**
 * Which client opened a socket, and what that changes about its rooms
 * (wave 4, 06/11/2026).
 *
 * Every dispatch socket used to be put in its own company's operations and
 * SAC rooms at connect. That is the web's tower and chat, which want the
 * whole operation for as long as the tab is open. The app wanted none of it:
 * an admin or operator with the app open received every position, route
 * event, chat message, typing hint and ticket of the fleet, and threw all of
 * it away (the deliveries listeners only mount for a driver). At ~3,600
 * tenants that is the fan-out of the whole platform's GPS to phones that do
 * not draw it.
 *
 * So the app says it is the app, and its socket joins those rooms only when
 * a screen asks (`operationsSubscribe` on focus), and leaves them when the
 * screen goes (`operationsUnsubscribe` on blur or background) — its own
 * company's room included. The web never says so and keeps the auto-join and
 * the lock that keeps its own room.
 *
 * The marker can only take rooms away from the socket that sends it: a client
 * that lies about being the app hears less, never more. That is why a
 * self-declared value is enough here, and why it is read from the handshake
 * and nowhere else.
 */

/** The same header the app sends on every HTTP request (`utils/api.ts`). */
const SOCKET_CLIENT_HEADER = "x-trajetto-client";

type SocketClient = "mobile" | "web";

interface ClientHandshake {
  headers?: Record<string, string | string[] | undefined>;
  auth?: unknown;
}

/**
 * The client a handshake declares: `mobile` when the app said so in the
 * header (`extraHeaders`) or in the handshake payload (`auth.client`), the
 * web otherwise. Builds of the app from before wave 4 say neither, and keep
 * the web's behaviour: they discard what those rooms carry, so the only cost
 * is the one they already had.
 */
function socketClientOf(handshake: ClientHandshake): SocketClient {
  const header = handshake.headers?.[SOCKET_CLIENT_HEADER];

  if (header === "mobile") return "mobile";

  const auth = handshake.auth;

  if (
    auth &&
    typeof auth === "object" &&
    (auth as { client?: unknown }).client === "mobile"
  ) {
    return "mobile";
  }

  return "web";
}

/**
 * Whether a dispatch socket is put in its own company's operations and SAC
 * rooms at connect. Only the web's: the app subscribes from the screen that
 * needs the operation.
 */
function joinsOwnDispatchRoomsOnConnect(
  client: SocketClient | undefined,
): boolean {
  return client !== "mobile";
}

/**
 * Whether an unsubscribe may take a socket out of its own company's
 * operations or SAC room. The web keeps the room it was given at connect (it
 * feeds the tab badge from anywhere in the panel); the app never got it at
 * connect, so it must be able to give back what it asked for.
 */
function mayLeaveOwnDispatchRooms(client: SocketClient | undefined): boolean {
  return client === "mobile";
}

export {
  SOCKET_CLIENT_HEADER,
  joinsOwnDispatchRoomsOnConnect,
  mayLeaveOwnDispatchRooms,
  socketClientOf,
};
export type { ClientHandshake, SocketClient };
