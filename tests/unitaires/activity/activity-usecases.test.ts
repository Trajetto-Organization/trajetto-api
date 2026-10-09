import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";

import { CreateActivityUseCase } from "@/modules/activity/usecases/create-activity/create-activity-usecase";
import { GetActivitySummaryUseCase } from "@/modules/activity/usecases/get-activity-summary/get-activity-summary-usecase";
import { ListActivitiesCursorUseCase } from "@/modules/activity/usecases/list-activities-cursor/list-activities-cursor-usecase";
import { ListAllActivitiesUseCase } from "@/modules/activity/usecases/list-all-activities/list-all-activities-usecase";

/**
 * The activity use cases on the in-memory twin: the scope always comes from
 * the stored session user, so a company reader asking for another company's
 * id gets its own trail, and only the MASTER picks a company.
 */
const A = "018f3000-0000-7000-8000-00000000000a";
const B = "018f3000-0000-7000-8000-00000000000b";

const ADMIN_A = "018f3000-0000-7000-8000-0000000000a1";
const CLERK_A = "018f3000-0000-7000-8000-0000000000a2";
const ADMIN_B = "018f3000-0000-7000-8000-0000000000b1";
const MASTER = "018f3000-0000-7000-8000-0000000000f1";

let users: InMemoryUserRepository;
let activities: InMemoryActivityRepository;

const people = [
  { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A },
  { id: CLERK_A, role: "BUSINESS_USER", businessId: A },
  { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B },
  { id: MASTER, role: "MASTER", businessId: null },
] as const;

beforeEach(() => {
  users = new InMemoryUserRepository();
  activities = new InMemoryActivityRepository();

  for (const person of people) {
    users.user.push({ ...person } as unknown as User);
    activities.users.set(person.id, {
      role: person.role,
      businessId: person.businessId,
      driverId: null,
      name: person.id,
      email: `${person.id}@exemplo.com.br`,
    });
  }

  activities.businesses.set(A, { corporate_reason: "Transportadora A" });
  activities.businesses.set(B, { corporate_reason: "Transportadora B" });

  activities.addActivity({ businessId: A, performedBy: ADMIN_A, type: "Veículo", action: "create" });
  activities.addActivity({ businessId: A, performedBy: CLERK_A, type: "Veículo", action: "update" });
  activities.addActivity({ businessId: A, performedBy: CLERK_A, type: "Motorista", action: "delete" });
  activities.addActivity({ businessId: B, performedBy: ADMIN_B, type: "Filial", action: "create", description: "Segredo da B" });
});

describe("CreateActivityUseCase", () => {
  it("records the activity with the canonical status and the default visibility", async () => {
    const created = await new CreateActivityUseCase(activities).execute({
      type: "Filial",
      action: "create",
      entityId: "branch-1",
      description: "Filial criada",
      status: "Completo",
      performedBy: ADMIN_A,
      businessId: A,
    } as never);

    expect(created.visibilityLevel).toBe("COMPANY");
    expect(created.tenantName).toBe("Transportadora A");
    expect(activities.activities).toContainEqual(expect.objectContaining({ id: created.id }));
  });

  it("collapses a replay of the same delivery's activity into the first one", async () => {
    const use = new CreateActivityUseCase(activities);
    const input = {
      type: "Entrega",
      action: "update",
      entityId: "delivery-1",
      deliveryId: "delivery-1",
      description: "Entrega atualizada",
      status: "Completo",
      performedBy: CLERK_A,
      businessId: A,
    } as never;

    const first = await use.execute(input);
    const second = await use.execute(input);

    expect(second.id).toBe(first.id);
    expect(activities.activities.filter((row) => row.deliveryId === "delivery-1")).toHaveLength(1);
  });

  it("answers a repository failure with a 500 AppError, never the raw error", async () => {
    const broken = {
      createActivity: async () => {
        throw new Error("connection reset");
      },
    } as never;

    await expect(
      new CreateActivityUseCase(broken).execute({} as never),
    ).rejects.toMatchObject({ statusCode: 500, message: "Erro ao registrar atividade" });
  });
});

describe("GetActivitySummaryUseCase", () => {
  const summary = () => new GetActivitySummaryUseCase(users, activities);

  it("counts the admin's company only, even when another company is asked", async () => {
    const result = await summary().execute({ userId: ADMIN_A, businessId: B, periodDays: 7 });

    expect(result).toMatchObject({
      total: 3,
      created: 1,
      updated: 1,
      deleted: 1,
      activeUsers: 2,
      topType: "Veículo",
      topTypeCount: 2,
      periodDays: 7,
    });
  });

  it("lets the MASTER scope the summary to one company", async () => {
    const result = await summary().execute({ userId: MASTER, businessId: B, periodDays: 30 });

    expect(result).toMatchObject({ total: 1, topType: "Filial" });
  });

  it("leaves activities older than the period out", async () => {
    activities.addActivity({
      businessId: A,
      performedBy: ADMIN_A,
      type: "Antigo",
      action: "create",
      created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const result = await summary().execute({ userId: ADMIN_A, periodDays: 30 });

    expect(result.total).toBe(3);
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(summary().execute({ userId: "nobody", periodDays: 7 })).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("ListActivitiesCursorUseCase", () => {
  const feed = () => new ListActivitiesCursorUseCase(users, activities);

  it("walks the company's feed newest first, page by page, without repeating a row", async () => {
    const first = await feed().execute({ userId: ADMIN_A, limit: 2, periodDays: 30 });

    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.data[1].id);

    const second = await feed().execute({
      userId: ADMIN_A,
      limit: 2,
      periodDays: 30,
      cursor: first.nextCursor as string,
    });

    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("ignores a foreign businessId sent by a company admin", async () => {
    const result = await feed().execute({ userId: ADMIN_A, limit: 10, periodDays: 30, businessId: B });

    expect(result.data.every((row) => row.businessId === A)).toBe(true);
    expect(result.data.map((row) => row.description)).not.toContain("Segredo da B");
  });

  it("shows a plain user only what they did", async () => {
    const result = await feed().execute({ userId: CLERK_A, limit: 10, periodDays: 30 });

    expect(result.data).toHaveLength(2);
    expect(result.data.every((row) => row.performedBy === CLERK_A)).toBe(true);
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(feed().execute({ userId: "nobody", limit: 10, periodDays: 7 })).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("ListAllActivitiesUseCase", () => {
  const table = () => new ListAllActivitiesUseCase(users, activities);

  it("pins a company admin to their company and counts the total over the whole trail", async () => {
    const result = await table().execute({
      userId: ADMIN_A,
      userRole: "BUSINESS_ADMIN",
      businessId: B,
      page: 1,
      pageSize: 2,
    });

    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((row) => row.businessId === A)).toBe(true);
  });

  it("filters on the server by action and type", async () => {
    const result = await table().execute({
      userId: ADMIN_A,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
      actions: ["delete"],
    } as never);

    expect(result.total).toBe(1);
    expect(result.data[0].type).toBe("Motorista");
  });

  it("lets the MASTER pick the company", async () => {
    const result = await table().execute({
      userId: MASTER,
      userRole: "MASTER",
      businessId: B,
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(1);
    expect(result.data[0].businessId).toBe(B);
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      table().execute({ userId: "nobody", userRole: "BUSINESS_ADMIN", page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });

  it("answers a repository failure with a 500 AppError", async () => {
    const broken = {
      listAllActivities: async () => {
        throw new Error("timeout");
      },
    } as never;

    await expect(
      new ListAllActivitiesUseCase(users, broken).execute({
        userId: ADMIN_A,
        userRole: "BUSINESS_ADMIN",
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 500, message: "Erro ao listar todas as atividades" });
  });
});

