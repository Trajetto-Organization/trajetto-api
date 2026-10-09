import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canSubscribeToChatBusiness,
  canWriteInChat,
  chatStaffRoom,
  readBusinessIdPayload,
} from "@/modules/chat/usecases/shared/chat-access-rules";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

describe("canWriteInChat", () => {
  it("lets the company's own people speak", () => {
    expect(canWriteInChat("BUSINESS_ADMIN")).toBe(true);
    expect(canWriteInChat("BUSINESS_USER")).toBe(true);
  });

  it("keeps the master silent", () => {
    expect(canWriteInChat("MASTER")).toBe(false);
  });

  it("treats a missing role as unable to write", () => {
    expect(canWriteInChat(null)).toBe(false);
    expect(canWriteInChat(undefined)).toBe(false);
    expect(canWriteInChat("")).toBe(false);
  });
});

describe("canSubscribeToChatBusiness", () => {
  const master = {
    role: "MASTER",
    businessId: null,
    isChatStaff: true,
  };

  const staff = {
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
    isChatStaff: true,
  };

  it("lets a master listen to any company they select", () => {
    expect(canSubscribeToChatBusiness(master, BUSINESS)).toBe(true);
    expect(canSubscribeToChatBusiness(master, OTHER_BUSINESS)).toBe(true);
  });

  it("pins everyone else to their own company", () => {
    expect(canSubscribeToChatBusiness(staff, BUSINESS)).toBe(true);
    expect(canSubscribeToChatBusiness(staff, OTHER_BUSINESS)).toBe(false);
  });

  it("keeps the room to the SAC side of the counter", () => {
    // A driver's socket must never hear the whole company's conversations.
    expect(
      canSubscribeToChatBusiness(
        { role: "BUSINESS_USER", businessId: BUSINESS, isChatStaff: false },
        BUSINESS,
      ),
    ).toBe(false);
  });

  it("refuses a companyless non-master and an empty request", () => {
    expect(
      canSubscribeToChatBusiness(
        { role: "BUSINESS_ADMIN", businessId: null, isChatStaff: true },
        BUSINESS,
      ),
    ).toBe(false);

    expect(canSubscribeToChatBusiness(master, "")).toBe(false);
    expect(canSubscribeToChatBusiness(staff, "")).toBe(false);
  });
});

describe("readBusinessIdPayload", () => {
  it("takes a non-empty business id and nothing else", () => {
    expect(readBusinessIdPayload({ businessId: BUSINESS })).toBe(BUSINESS);
    expect(readBusinessIdPayload({ businessId: `  ${BUSINESS}  ` })).toBe(
      BUSINESS,
    );
  });

  it("answers null to every malformed frame", () => {
    expect(readBusinessIdPayload(undefined)).toBeNull();
    expect(readBusinessIdPayload(null)).toBeNull();
    expect(readBusinessIdPayload("business")).toBeNull();
    expect(readBusinessIdPayload({})).toBeNull();
    expect(readBusinessIdPayload({ businessId: "" })).toBeNull();
    expect(readBusinessIdPayload({ businessId: "   " })).toBeNull();
    expect(readBusinessIdPayload({ businessId: 42 })).toBeNull();
    expect(readBusinessIdPayload({ businessId: { id: BUSINESS } })).toBeNull();
  });

  // RT-1 on the chat side: the id becomes a room name published through
  // Redis with every emit, and any string up to the 16 KB frame was taken.
  it("takes only a company id shaped like one, lower-cased", () => {
    expect(readBusinessIdPayload({ businessId: "not-a-company" })).toBeNull();
    expect(readBusinessIdPayload({ businessId: "x".repeat(16_000) })).toBeNull();
    expect(
      readBusinessIdPayload({ businessId: `${BUSINESS}${" ".repeat(60)}` }),
    ).toBeNull();
    expect(readBusinessIdPayload({ businessId: BUSINESS.toUpperCase() })).toBe(
      BUSINESS,
    );
  });
});

describe("the chat's access refusals", () => {
  // Decision 4.1: PERMISSION_DENIED / MODULE_NOT_ENABLED / TENANT_INACTIVE
  // come from the factories in src/shared/errors/access-errors.ts only. The
  // recipients use case spelled PERMISSION_DENIED by hand.
  it("are raised through the shared factories, never spelled by hand", () => {
    const root = join(__dirname, "..", "..", "..", "src", "modules", "chat");

    const files = (function walk(directory: string): string[] {
      return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);

        return statSync(path).isDirectory()
          ? walk(path)
          : path.endsWith(".ts")
            ? [path]
            : [];
      });
    })(root);

    expect(files.length).toBeGreaterThan(20);

    const offenders = files.filter((file) =>
      /["'`](PERMISSION_DENIED|MODULE_NOT_ENABLED|TENANT_INACTIVE)["'`]/.test(
        readFileSync(file, "utf8"),
      ),
    );

    expect(offenders).toEqual([]);
  });
});

describe("chatStaffRoom", () => {
  it("names one room per company", () => {
    expect(chatStaffRoom(BUSINESS)).toBe(`chat-staff:${BUSINESS}`);
    expect(chatStaffRoom(BUSINESS)).not.toBe(chatStaffRoom(OTHER_BUSINESS));
  });
});
