import { describe, expect, it, beforeEach } from "vitest";

import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";
import { dashboardResponses } from "@/routes/documentation/dashboard-documentation";
import {
  presentActivityActor,
  PLATFORM_ACTOR_NAME,
  PLATFORM_ROLE,
} from "@/shared/activity/actor-presentation";

describe("activity actor presentation", () => {
  const masterActivity = {
    id: "1",
    user: {
      name: "Daniel Mesquita da Costa",
      email: "daniel@pessoal.com",
      role: "MASTER",
    },
  };

  it("keeps real identities for the back office", () => {
    const seen = presentActivityActor(masterActivity, "MASTER");

    expect(seen.user?.name).toBe("Daniel Mesquita da Costa");
    expect(seen.user?.email).toBe("daniel@pessoal.com");
  });

  it("collapses a master into the platform for a company reader", () => {
    const seen = presentActivityActor(masterActivity, "BUSINESS_ADMIN");

    expect(seen.user?.name).toBe(PLATFORM_ACTOR_NAME);
    expect(seen.user?.role).toBe(PLATFORM_ROLE);

    // A personal address is not the customer's to receive.
    expect(seen.user?.email).toBeNull();
  });

  it("leaves the company's own people untouched", () => {
    const own = {
      id: "2",
      user: { name: "Ana", email: "ana@empresa.com", role: "BUSINESS_USER" },
    };

    expect(presentActivityActor(own, "BUSINESS_ADMIN")).toEqual(own);
  });

  it("does not mutate the row it was given", () => {
    presentActivityActor(masterActivity, "BUSINESS_ADMIN");
    expect(masterActivity.user.email).toBe("daniel@pessoal.com");
  });

  it("survives the dashboard response schema", () => {
    // Fastify parses every response against its schema. A masked row carries
    // a null e-mail, and a schema that demanded a string silently emptied the
    // whole "Atividades Recentes" card for company admins — the rows existed,
    // the serializer dropped them.
    const masked = presentActivityActor(
      {
        id: "01a0",
        type: "Plano",
        action: "update",
        entityId: "biz-1",
        description: "Módulo Entregas: habilitado → desabilitado",
        status: "Inativo",
        performedBy: "master-1",
        businessId: "biz-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user: {
          email: "daniel@pessoal.com",
          role: "MASTER",
          name: "Daniel",
        },
      },
      "BUSINESS_ADMIN",
    );

    const shape =
      dashboardResponses.dashboardOverview.shape.recentActivity.element;

    const parsed = shape.safeParse(masked);

    expect(parsed.success).toBe(true);
    expect(masked.user?.email).toBeNull();
  });
});

describe("activity cursor feed", () => {
  let repository: InMemoryActivityRepository;

  const feed = (cursor?: string, limit = 3) =>
    repository.listActivitiesWithCursor({
      currentUserRole: "MASTER",
      userId: "user-1",
      limit,
      cursor,
      periodDays: 7,
    });

  beforeEach(async () => {
    repository = new InMemoryActivityRepository();

    // Ten activities, oldest first — ids are uuid v7, so they come out of the
    // feed in the reverse order they went in.
    for (let index = 0; index < 10; index += 1) {
      await repository.createActivity({
        type: "Plano",
        action: "update",
        entityId: `entity-${index}`,
        description: `Atividade ${index}`,
        status: "Atualizado",
        performedBy: "user-1",
        businessId: "biz-1",
      });
    }
  });

  it("walks newest first without repeating a row", async () => {
    const first = await feed();
    const second = await feed(first.nextCursor ?? undefined);

    expect(first.data).toHaveLength(3);
    expect(second.data).toHaveLength(3);

    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(6);

    // Descending by id is descending by creation time for uuid v7.
    expect(first.data[0].description).toBe("Atividade 9");
    expect(second.data[0].description).toBe("Atividade 6");
  });

  it("does not drift when rows are written between pages", async () => {
    const first = await feed();

    // The exact scenario offsets get wrong: with `skip`, everything shifts
    // down and page two would hand back rows page one already showed.
    await repository.createActivity({
      type: "Plano",
      action: "update",
      entityId: "entity-new",
      description: "Chegou depois",
      status: "Atualizado",
      performedBy: "user-1",
      businessId: "biz-1",
    });

    const second = await feed(first.nextCursor ?? undefined);
    const ids = [...first.data, ...second.data].map((row) => row.id);

    expect(new Set(ids).size).toBe(6);
    expect(second.data.map((row) => row.description)).not.toContain(
      "Atividade 9",
    );
  });

  it("reports hasMore only while another row exists", async () => {
    const page = await feed(undefined, 10);

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.data).toHaveLength(10);
  });

  it("keeps the feed inside the selected window", async () => {
    const [oldest] = repository.activities;

    // Sits outside 7 days but inside 30 — the one placement that proves the
    // window is really applied, and that the two options differ.
    oldest.created_at = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    const week = await feed(undefined, 50);
    expect(week.data).toHaveLength(9);

    const month = await repository.listActivitiesWithCursor({
      currentUserRole: "MASTER",
      userId: "user-1",
      limit: 50,
      periodDays: 30,
    });

    expect(month.data).toHaveLength(10);
  });
});
