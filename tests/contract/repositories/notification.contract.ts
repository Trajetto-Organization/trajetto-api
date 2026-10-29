import { describe, expect, it } from "vitest";

import type { INotificationRepository } from "@/modules/notification/repositories/INotification-repository";

import { expectPrismaCode, fixedId, type Kind } from "../support";

/**
 * The notification repository's contract (decision 13.2): the inbox feed
 * (per user, newest first, cursor), the unread counts, the read/delete
 * writes and the preferences upsert.
 */

const NOTIFICATION_FIXTURE = {
  A: fixedId("0b1a", 1),
  userA: fixedId("0b1b", 1),
  userB: fixedId("0b1b", 2),
} as const;

const F = NOTIFICATION_FIXTURE;

interface NotificationHarness {
  kind: Kind;
  repo: INotificationRepository;
  /** Ids created by the seed, newest last; t1..t3 share one instant. */
  id(key: string): string;
}

const NOTIFICATION_SEED: Array<{
  key: string;
  userId: string;
  minute: number;
  read?: boolean;
}> = [
  { key: "old", userId: F.userA, minute: 1, read: true },
  // One fan-out: three rows written in the same instant.
  { key: "t1", userId: F.userA, minute: 5 },
  { key: "t2", userId: F.userA, minute: 5 },
  { key: "t3", userId: F.userA, minute: 5 },
  { key: "other", userId: F.userB, minute: 6 },
];

function notificationRepositoryContract(
  harness: () => NotificationHarness,
): void {
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

  it("walks the inbox one row at a time through a tie without repeating or skipping", async () => {
    const h = harness();
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 6; page += 1) {
      const result = await h.repo.listUserNotificationsWithCursor({
        userId: F.userA,
        limit: 1,
        cursor,
      });

      seen.push(...ids(result.data));
      if (!result.hasMore) break;
      cursor = result.nextCursor ?? undefined;
    }

    const tie = [h.id("t1"), h.id("t2"), h.id("t3")].sort().reverse();

    expect(seen).toEqual([...tie, h.id("old")]);
  });

  it("counts the user's total and unread, never another user's", async () => {
    const h = harness();
    const unreadOnly = await h.repo.listUserNotificationsWithCursor({
      userId: F.userA,
      includeRead: false,
      limit: 10,
    });

    expect(unreadOnly.total).toBe(3);
    expect(unreadOnly.unread).toBe(3);
    expect(ids(unreadOnly.data)).not.toContain(h.id("other"));
    expect(await h.repo.countUnreadNotifications(F.userB)).toBe(1);
  });

  it("answers a cursor that is not a row with nothing", async () => {
    const page = await harness().repo.listUserNotificationsWithCursor({
      userId: F.userA,
      cursor: fixedId("0b1c", 99),
    });

    expect(page.data).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("marks one or all as read and refuses a missing row (P2025)", async () => {
    const h = harness();

    expect((await h.repo.markAsRead(h.id("t1"))).read).toBe(true);
    expect(await h.repo.markAllAsRead(F.userA)).toBe(2);
    expect(await h.repo.countUnreadNotifications(F.userA)).toBe(0);
    expect(await h.repo.countUnreadNotifications(F.userB)).toBe(1);

    await expectPrismaCode(h.repo.markAsRead(fixedId("0b1c", 99)), "P2025");
    await expectPrismaCode(
      h.repo.deleteNotification(fixedId("0b1c", 99)),
      "P2025",
    );
  });

  describe("preferences", () => {
    it("keep one row per category, updated in place", async () => {
      const { repo } = harness();

      await repo.upsertPreferences(F.userA, [
        { category: "MAINTENANCE", inApp: true, email: false, whatsapp: false },
        { category: "SYSTEM", inApp: true, email: true, whatsapp: true },
      ]);
      await repo.upsertPreferences(F.userA, [
        { category: "MAINTENANCE", inApp: false, email: true, whatsapp: false },
      ]);

      const rows = (await repo.listPreferences(F.userA))
        .map(({ category, inApp, email, whatsapp }) => ({
          category,
          inApp,
          email,
          whatsapp,
        }))
        .sort((a, b) => (a.category < b.category ? -1 : 1));

      expect(rows).toEqual([
        { category: "MAINTENANCE", inApp: false, email: true, whatsapp: false },
        { category: "SYSTEM", inApp: true, email: true, whatsapp: true },
      ]);
      expect(await repo.listPreferences(F.userB)).toEqual([]);
    });
  });
}

export {
  NOTIFICATION_FIXTURE,
  NOTIFICATION_SEED,
  notificationRepositoryContract,
};
export type { NotificationHarness };
