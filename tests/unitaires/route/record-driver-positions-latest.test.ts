import { beforeEach, describe, expect, it, vi } from "vitest";

const realtime = vi.hoisted(() => ({
  sendDriverPositionToBusiness: vi.fn(),
}));

vi.mock("@/shared/route/route-realtime", () => realtime);

import { RecordDriverPositionsUseCase } from "@/modules/route/usecases/record-driver-positions/record-driver-positions-usecase";
import { latestPing } from "@/shared/route/driver-position-rules";

/**
 * The dot the tower draws is the NEWEST point, not the last one in the body.
 *
 * The announcement took `accepted[accepted.length - 1]` — the order the phone
 * happened to send. An outbox resending an older batch after a newer one, or
 * a phone that buffers out of order, put the truck back where it was minutes
 * ago until the next ping. The database row already kept the newest by
 * `recorded_at`; the socket now says the same thing.
 */
const newer = new Date(Date.now() - 60_000);
const older = new Date(Date.now() - 5 * 60_000);

const ping = (recorded_at: Date, latitude: number) => ({
  latitude,
  longitude: -46.63,
  accuracy: 10,
  recorded_at: recorded_at.toISOString(),
});

let useCase: RecordDriverPositionsUseCase;

beforeEach(() => {
  realtime.sendDriverPositionToBusiness.mockClear();

  useCase = new RecordDriverPositionsUseCase(
    {
      findUserById: async () => ({
        id: "user-1",
        driverId: "driver-1",
        businessId: "business-1",
      }),
    } as never,
    {
      findDriverRoute: async () => ({ id: "route-1", status: "IN_PROGRESS" }),
      findActiveRouteForDriver: async () => ({
        id: "route-1",
        started_at: new Date(Date.now() - 60 * 60_000),
      }),
    } as never,
    {
      recordBatch: async ({ pings }: { pings: unknown[] }) => ({
        stored: pings.length,
        dropped: 0,
      }),
    } as never,
  );
});

describe("the position the tower is told about", () => {
  it("is the newest by device time, whatever the order of the batch", async () => {
    await useCase.execute({
      userId: "user-1",
      pings: [ping(newer, -23.5), ping(older, -23.9)],
    });

    expect(realtime.sendDriverPositionToBusiness).toHaveBeenCalledTimes(1);
    expect(realtime.sendDriverPositionToBusiness).toHaveBeenCalledWith(
      "business-1",
      expect.objectContaining({
        recordedAt: newer.toISOString(),
        latitude: -23.5,
      }),
    );
  });
});

describe("latestPing", () => {
  it("picks the greatest recorded_at", () => {
    const pings = [
      { recorded_at: newer, id: "b" },
      { recorded_at: older, id: "a" },
    ];

    expect(latestPing(pings).id).toBe("b");
  });

  it("lets the later one win a tie, as the batch order did", () => {
    const pings = [
      { recorded_at: newer, id: "first" },
      { recorded_at: new Date(newer), id: "second" },
    ];

    expect(latestPing(pings).id).toBe("second");
  });
});
