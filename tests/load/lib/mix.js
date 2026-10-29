import { sleep } from "k6";

import { surfaces } from "./api.js";

/**
 * What a minute of the real operation looks like, as a weighted mix.
 *
 * Every load test that asks for one endpoint in a tight loop measures that
 * endpoint and nothing else — it never finds the contention that only appears
 * when a bulk insert and five aggregates want the same connection pool at the
 * same second. So the mix is the point, and the weights come from what the
 * product actually does:
 *
 * - Position pings dominate. Twenty thousand drivers at one flush per thirty
 *   seconds is ~670 writes a second, which the capacity ruler already names as
 *   the heaviest single write on the platform.
 * - The driver's list is fetched on every app open and every pull-to-refresh.
 * - The dispatcher's board and the tower are opened by a handful of people per
 *   carrier and then left open, refreshing.
 * - The public API is a machine walking pages, steady and unattended.
 * - The chat's thread list is opened once and left there; a conversation is
 *   opened whenever somebody writes.
 */
const MIX = [
  { weight: 34, run: (vu) => surfaces.recordPositions(vu) },
  { weight: 16, run: (vu) => surfaces.myDeliveries(vu) },

  { weight: 12, run: () => surfaces.listDeliveries() },
  { weight: 8, run: () => surfaces.getDelivery() },

  { weight: 6, run: () => surfaces.listRoutes() },
  { weight: 5, run: () => surfaces.controlTower() },
  { weight: 5, run: () => surfaces.operationSummary() },

  { weight: 5, run: () => surfaces.integrationDeliveries() },
  { weight: 4, run: () => surfaces.unreadCount() },
  { weight: 3, run: () => surfaces.dashboardOverview() },

  /*
    The chat, which was in no scenario at all. A carrier's office leaves the
    thread list open beside the board and opens a conversation whenever a
    driver writes — heavy reads from people who are idle, which is exactly the
    shape that hides in a mix built only from the busy surfaces.
  */
  { weight: 4, run: () => surfaces.chatThreads() },
  { weight: 3, run: (vu) => surfaces.chatMessages(vu) },

  { weight: 2, run: () => surfaces.catalogue() },
];

const TOTAL_WEIGHT = MIX.reduce((sum, entry) => sum + entry.weight, 0);

function runOneOperation(vu) {
  let ticket = Math.random() * TOTAL_WEIGHT;

  for (const entry of MIX) {
    ticket -= entry.weight;

    if (ticket <= 0) return entry.run(vu);
  }

  return MIX[0].run(vu);
}

/**
 * A pause between operations, so a virtual user behaves like a client and not
 * like a fuzzer.
 *
 * Without it every VU is a closed loop at whatever rate the server can answer,
 * which measures the server's ceiling and nothing about its behaviour under a
 * realistic arrival pattern — and makes the latency numbers meaningless,
 * because they are all queueing behind the same VU's previous request.
 */
function pause(min = 0.5, max = 2) {
  sleep(min + Math.random() * (max - min));
}

export { MIX, pause, runOneOperation };
