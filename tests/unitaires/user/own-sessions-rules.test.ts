import { describe, expect, it } from "vitest";

import { v4 as uuidV4, v7 as uuidV7 } from "uuid";

import {
  groupOwnSessions,
  sessionFamilyOf,
  sessionKind,
} from "@/modules/user/services/own-sessions";
import { familyStartedAtOf } from "@/modules/user/services/session-service";

/**
 * The reads behind "Aparelhos conectados" and the password change that keeps
 * the session (wave 2), pure: when a family was born, which client holds it,
 * and whether the session a request runs in is still live.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-06T12:00:00.000Z");

describe("a family's birth, read from its id", () => {
  // The family's first row is purged once it lapses, long before a 30- or
  // 180-day cap; the UUIDv7 id keeps the login's millisecond.
  it("is the UUIDv7's time, rounded down to the second", () => {
    const id = uuidV7({ msecs: Date.parse("2026-11-01T08:30:15.987Z") });

    expect(familyStartedAtOf(id)).toBe(
      Math.floor(Date.parse("2026-11-01T08:30:15.000Z") / 1000),
    );
  });

  it("is unknown for an id of another version", () => {
    expect(familyStartedAtOf(uuidV4())).toBeNull();
    expect(familyStartedAtOf("not-a-uuid")).toBeNull();
  });
});

describe("which client holds a session", () => {
  it("is the phone when the rows carry a phone id", () => {
    expect(sessionKind(true, NOW, new Date(NOW.getTime() + DAY), false)).toBe(
      "aparelho",
    );
  });

  // The web idles one day; only the mobile policy idles longer without a
  // phone.
  it("is the app when the latest token lives longer than the web's day", () => {
    expect(
      sessionKind(false, NOW, new Date(NOW.getTime() + 7 * DAY), false),
    ).toBe("app");
  });

  it("is the browser for a day-long token with no push device", () => {
    expect(sessionKind(false, NOW, new Date(NOW.getTime() + DAY), false)).toBe(
      "navegador",
    );
  });

  // The last day of the app's 30-day cap looks like the web's day: the push
  // device only the app registers still tells them apart.
  it("is the app for a short token whose session registered a push device", () => {
    expect(
      sessionKind(false, NOW, new Date(NOW.getTime() + 2 * HOUR), true),
    ).toBe("app");
  });
});

describe("the person's sessions", () => {
  it("are one entry per family, most recently used first, with the family's birth", () => {
    const phone = uuidV7({ msecs: NOW.getTime() - 10 * DAY });
    const browser = uuidV7({ msecs: NOW.getTime() - DAY });
    const legacy = uuidV4();

    const sessions = groupOwnSessions(
      [
        // A raced renewal: two live rows of one family.
        {
          family_id: phone,
          device_id: "23be03c084165505",
          created_at: new Date(NOW.getTime() - 2 * HOUR),
          expires_in: new Date(NOW.getTime() + 30 * DAY - 2 * HOUR),
        },
        {
          family_id: phone,
          device_id: "23be03c084165505",
          created_at: new Date(NOW.getTime() - HOUR),
          expires_in: new Date(NOW.getTime() + 30 * DAY - HOUR),
        },
        {
          family_id: browser,
          device_id: null,
          created_at: new Date(NOW.getTime() - 3 * HOUR),
          expires_in: new Date(NOW.getTime() + DAY - 3 * HOUR),
        },
        {
          family_id: legacy,
          device_id: null,
          created_at: new Date(NOW.getTime() - 5 * HOUR),
          expires_in: new Date(NOW.getTime() + 7 * DAY - 5 * HOUR),
        },
      ],
      new Set(),
    );

    expect(sessions).toEqual([
      {
        family_id: phone,
        kind: "aparelho",
        created_at: new Date(familyStartedAtOf(phone)! * 1000),
        last_activity_at: new Date(NOW.getTime() - HOUR),
        expires_at: new Date(NOW.getTime() + 30 * DAY - HOUR),
      },
      {
        family_id: browser,
        kind: "navegador",
        created_at: new Date(familyStartedAtOf(browser)! * 1000),
        last_activity_at: new Date(NOW.getTime() - 3 * HOUR),
        expires_at: new Date(NOW.getTime() + DAY - 3 * HOUR),
      },
      // An id that is not a v7: its oldest live row.
      {
        family_id: legacy,
        kind: "app",
        created_at: new Date(NOW.getTime() - 5 * HOUR),
        last_activity_at: new Date(NOW.getTime() - 5 * HOUR),
        expires_at: new Date(NOW.getTime() + 7 * DAY - 5 * HOUR),
      },
    ]);
  });

  it("never carry the phone's id", () => {
    const sessions = groupOwnSessions(
      [
        {
          family_id: uuidV7(),
          device_id: "23be03c084165505",
          created_at: NOW,
          expires_in: new Date(NOW.getTime() + DAY),
        },
      ],
      new Set(),
    );

    expect(JSON.stringify(sessions)).not.toContain("23be03c084165505");
  });
});

describe("the session a request runs in", () => {
  const family = uuidV7();

  it("is re-issuable while one of its rows is live, with its phone and first row", () => {
    expect(
      sessionFamilyOf(
        family,
        [
          {
            device_id: null,
            created_at: new Date(NOW.getTime() - 2 * HOUR),
            revoked_at: new Date(NOW.getTime() - HOUR),
            expires_in: new Date(NOW.getTime() + DAY),
          },
          {
            device_id: "23be03c084165505",
            created_at: new Date(NOW.getTime() - HOUR),
            revoked_at: null,
            expires_in: new Date(NOW.getTime() + DAY),
          },
        ],
        NOW,
      ),
    ).toEqual({
      family_id: family,
      device_id: "23be03c084165505",
      first_issued_at: new Date(NOW.getTime() - 2 * HOUR),
    });
  });

  it("is over when every row is revoked or expired", () => {
    expect(
      sessionFamilyOf(
        family,
        [
          {
            device_id: null,
            created_at: new Date(NOW.getTime() - 2 * DAY),
            revoked_at: null,
            expires_in: new Date(NOW.getTime() - DAY),
          },
          {
            device_id: null,
            created_at: new Date(NOW.getTime() - HOUR),
            revoked_at: new Date(NOW.getTime() - 1000),
            expires_in: new Date(NOW.getTime() + DAY),
          },
        ],
        NOW,
      ),
    ).toBeNull();
    expect(sessionFamilyOf(family, [], NOW)).toBeNull();
  });
});
