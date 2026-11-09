import { describe, expect, it } from "vitest";

import { inAppPushData, withPushOwner } from "@/shared/notifications/push-data";
import { renderServiceOrderCreatedInApp } from "@/shared/notifications/policies/service-order-created-policy";
import { renderKanbanCardCreatedInApp } from "@/shared/notifications/policies/kanban-card-policies";

/**
 * What a push carries to the phone (wave 3).
 *
 * The tray message and the inbox row are separate deliveries, so a tap on
 * an order's push could only open the notifications screen. The data now
 * names the item (`entityId`), its company (`businessId`, as the inbox row
 * stores it) and the person it was sent to (`userId`), so the app opens the
 * item itself and refuses a stale notice of another login on a shared phone.
 * Ids only: nothing personal rides through Expo to a lock screen. Additive:
 * `url`, `link` and `type` stay, so a build that reads only `url` still
 * opens the notifications screen.
 */
const USER = "018f3700-0000-7000-8000-0000000000a1";
const COMPANY = "018f3700-0000-7000-8000-00000000000a";
const ORDER = "018f3700-0000-7000-8000-0000000000e1";
const CARD = "018f3700-0000-7000-8000-0000000000c1";

const ctx = { baseUrl: "https://app.trajetto.com.br" };
const driver = { id: USER, role: "BUSINESS_USER", driverId: "driver-1" };

describe("the push data of a topic whose push is its in-app render", () => {
  it("keeps url, link and type and adds the item, the company and the recipient", () => {
    const rendered = renderServiceOrderCreatedInApp(
      {
        serviceOrderId: ORDER,
        businessId: COMPANY,
        vehicleId: "018f3700-0000-7000-8000-0000000000f1",
        vehiclePlate: "ABC1D23",
        totalAmount: 1850,
        currentMileage: 120_000,
        newMileage: null,
        isCompleted: false,
        responsibleUserId: USER,
      },
      ctx,
      driver,
    );

    expect(
      inAppPushData(rendered, { userId: USER, businessId: COMPANY }),
    ).toEqual({
      url: "/notifications",
      link: rendered.link,
      type: "service-order",
      entityId: ORDER,
      businessId: COMPANY,
      userId: USER,
    });
  });

  it("names the Kanban card the driver is designated to", () => {
    const rendered = renderKanbanCardCreatedInApp(
      {
        cardId: CARD,
        businessId: COMPANY,
        title: "Levar à revisão",
        description: null,
        priority: "high",
        dueDate: null,
        isCompleted: false,
        assignedUserId: USER,
        fromServiceOrder: false,
      },
      ctx,
      driver,
    );

    expect(
      inAppPushData(rendered, { userId: USER, businessId: COMPANY }),
    ).toMatchObject({ type: "kanban-card", entityId: CARD, userId: USER });
  });

  it("carries ids only: no title, message, plate or amount", () => {
    const data = inAppPushData(
      {
        type: "service-order",
        link: "https://app.trajetto.com.br/driver/vehicles/x/service-orders",
        entityId: ORDER,
      },
      { userId: USER, businessId: COMPANY },
    );

    expect(Object.keys(data).sort()).toEqual(
      ["businessId", "entityId", "link", "type", "url", "userId"].sort(),
    );
  });

  // Wave 4: a render's push-only ids (the authorization request's kind and
  // occurrence) are added beside the row's coordinates, never over them.
  it("adds a render's push-only ids without replacing the row's or the owner's", () => {
    const data = inAppPushData(
      {
        type: "delivery",
        link: "https://app.trajetto.com.br/dashboard/control-tower",
        entityId: ORDER,
        pushData: {
          kind: "occurrence-authorization",
          occurrenceId: CARD,
          type: "forged",
          entityId: "forged",
          userId: "forged",
          url: "/forged",
        },
      },
      { userId: USER, businessId: COMPANY },
    );

    expect(data).toEqual({
      url: "/notifications",
      link: "https://app.trajetto.com.br/dashboard/control-tower",
      type: "delivery",
      entityId: ORDER,
      kind: "occurrence-authorization",
      occurrenceId: CARD,
      businessId: COMPANY,
      userId: USER,
    });
  });

  it("leaves out what the event does not have instead of sending empty values", () => {
    const data = inAppPushData(
      { type: "master-user", link: "", entityId: "" },
      { userId: USER, businessId: null },
    );

    expect(data).toEqual({
      url: "/notifications",
      link: "",
      type: "master-user",
      userId: USER,
    });
  });
});

describe("the push data of a push-only topic (chat, route, the tower)", () => {
  it("keeps the policy's data and adds the company and the recipient beside it", () => {
    expect(
      withPushOwner(
        { url: "/route", routeId: "route-1", planVersion: 3 },
        { userId: USER, businessId: COMPANY },
      ),
    ).toEqual({
      url: "/route",
      routeId: "route-1",
      planVersion: 3,
      businessId: COMPANY,
      userId: USER,
    });
  });

  it("never overwrites a key the policy set", () => {
    expect(
      withPushOwner(
        { url: "/deliveries", entityId: ORDER, businessId: "set-by-policy" },
        { userId: USER, businessId: COMPANY },
      ),
    ).toMatchObject({ entityId: ORDER, businessId: "set-by-policy" });
  });
});
