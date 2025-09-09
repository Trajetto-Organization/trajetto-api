import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListRecentActivitiesUseCase } from "@/modules/activity/usecases/list-recent-activities/list-recent-activities-usecase";

import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

describe("List Recent Activities UseCase", () => {
  let activityInMemory: InMemoryActivityRepository;
  let userInMemory: InMemoryUserRepository;

  let listRecentActivitiesUseCase: ListRecentActivitiesUseCase;

  beforeEach(() => {
    activityInMemory = new InMemoryActivityRepository();
    userInMemory = new InMemoryUserRepository();

    listRecentActivitiesUseCase = new ListRecentActivitiesUseCase(
      userInMemory,
      activityInMemory,
    );
  });

  it("should be able to list recent activities for MASTER user", async () => {
    const createdUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Add test activities
    const activities = [
      {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-1",
        description: "Veículo criado",
        status: "Completo",
        performedBy: "user-1",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
      {
        type: "driver",
        action: "update",
        entityId: "driver-1",
        description: "Motorista atualizado",
        status: "Completo",
        performedBy: "user-2",
        businessId: "business-456",
        visibilityLevel: "SYSTEM",
      },
      {
        type: "user",
        action: "delete",
        entityId: "user-3",
        description: "Usuário removido",
        status: "Completo",
        performedBy: "user-3",
        businessId: "business-789",
        visibilityLevel: "USER",
      },
    ];

    for (const activity of activities) {
      await activityInMemory.createActivity(activity);
    }

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "MASTER",
      page: 1,
      pageSize: 10,
    });

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("total");

    expect(result.data).toHaveLength(3); // MASTER can see all activities
    expect(result.total).toBe(3);

    // Check data structure
    result.data.forEach((activity) => {
      expect(activity).toHaveProperty("id");
      expect(activity).toHaveProperty("type");
      expect(activity).toHaveProperty("action");
      expect(activity).toHaveProperty("description");
      expect(activity).toHaveProperty("userEmail");
      expect(activity).toHaveProperty("userName");
      expect(activity).toHaveProperty("userRole");
    });
  });

  it("should be able to list recent activities for BUSINESS_ADMIN user", async () => {
    const createdUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "password",
      name: "Business Admin",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    // Add test activities
    const activities = [
      {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-1",
        description: "Veículo criado",
        status: "Completo",
        performedBy: "user-1",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
      {
        type: "system",
        action: "backup",
        entityId: "system-1",
        description: "Backup realizado",
        status: "Completo",
        performedBy: "system",
        businessId: "business-123",
        visibilityLevel: "SYSTEM", // Should be filtered out
      },
      {
        type: "driver",
        action: "update",
        entityId: "driver-1",
        description: "Motorista atualizado",
        status: "Completo",
        performedBy: "user-2",
        businessId: "business-456", // Different business, should be filtered out
        visibilityLevel: "COMPANY",
      },
    ];

    for (const activity of activities) {
      await activityInMemory.createActivity(activity);
    }

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(1); // Only COMPANY level activities from same business
    expect(result.total).toBe(1);
    expect(result.data[0].type).toBe("vehicle");
    expect(result.data[0].description).toBe("Veículo criado");
  });

  it("should be able to list recent activities for BUSINESS_USER", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_USER",
    });

    // Add test activities
    const activities = [
      {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-1",
        description: "Veículo criado por outro usuário",
        status: "Completo",
        performedBy: "other-user",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
      {
        type: "profile",
        action: "update",
        entityId: "profile-1",
        description: "Perfil atualizado pelo próprio usuário",
        status: "Completo",
        performedBy: createdUser.id, // Same user
        businessId: "business-123",
        visibilityLevel: "USER",
      },
      {
        type: "system",
        action: "backup",
        entityId: "system-1",
        description: "Backup realizado",
        status: "Completo",
        performedBy: "system",
        businessId: "business-123",
        visibilityLevel: "SYSTEM", // Should be filtered out
      },
    ];

    for (const activity of activities) {
      await activityInMemory.createActivity(activity);
    }

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_USER",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(2); // COMPANY + USER activities for same user
    expect(result.total).toBe(2);

    const descriptions = result.data.map((a) => a.description);

    expect(descriptions).toContain("Veículo criado por outro usuário");
    expect(descriptions).toContain("Perfil atualizado pelo próprio usuário");
  });

  it("should filter activities by businessId", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    // Add activities from different businesses
    const activities = [
      {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-1",
        description: "Veículo business 123",
        status: "Completo",
        performedBy: "user-1",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
      {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-2",
        description: "Veículo business 456",
        status: "Completo",
        performedBy: "user-2",
        businessId: "business-456",
        visibilityLevel: "COMPANY",
      },
    ];

    for (const activity of activities) {
      await activityInMemory.createActivity(activity);
    }

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].description).toBe("Veículo business 123");
  });

  it("should filter activities by search term", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    // Add test activities
    const activities = [
      {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-1",
        description: "Veículo Volkswagen criado",
        status: "Completo",
        performedBy: "user-1",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
      {
        type: "vehicle",
        action: "update",
        entityId: "vehicle-2",
        description: "Veículo Ford atualizado",
        status: "Completo",
        performedBy: "user-2",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
      {
        type: "driver",
        action: "create",
        entityId: "driver-1",
        description: "Motorista João criado",
        status: "Completo",
        performedBy: "user-3",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      },
    ];

    for (const activity of activities) {
      await activityInMemory.createActivity(activity);
    }

    // Search by description
    let result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
      search: "Volkswagen",
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].description).toBe("Veículo Volkswagen criado");

    // Search by type
    result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
      search: "driver",
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].description).toBe("Motorista João criado");

    // Search by action
    result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
      search: "update",
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].description).toBe("Veículo Ford atualizado");
  });

  it("should handle pagination correctly", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    // Add 15 activities
    for (let i = 1; i <= 15; i++) {
      await activityInMemory.createActivity({
        type: "vehicle",
        action: "create",
        entityId: `vehicle-${i}`,
        description: `Veículo ${i} criado`,
        status: "Completo",
        performedBy: "user-1",
        businessId: "business-123",
        visibilityLevel: "COMPANY",
      });
    }

    // First page (5 items)
    let result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 5,
    });

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(15);

    // Second page (5 items)
    result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 2,
      pageSize: 5,
    });

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(15);

    // Third page (5 items)
    result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 3,
      pageSize: 5,
    });

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(15);

    // Fourth page (empty)
    result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 4,
      pageSize: 5,
    });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(15);
  });

  it("should sort activities by creation date (most recent first)", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    // Add activities with different dates
    const baseDate = new Date("2024-01-01");

    await activityInMemory.addActivity({
      type: "vehicle",
      action: "create",
      entityId: "vehicle-1",
      description: "Primeiro veículo",
      status: "Completo",
      performedBy: "user-1",
      businessId: "business-123",
      visibilityLevel: "COMPANY",
      created_at: new Date(baseDate.getTime() + 1000), // Later
    });

    await activityInMemory.addActivity({
      type: "vehicle",
      action: "create",
      entityId: "vehicle-2",
      description: "Segundo veículo",
      status: "Completo",
      performedBy: "user-2",
      businessId: "business-123",
      visibilityLevel: "COMPANY",
      created_at: new Date(baseDate.getTime()), // Earlier
    });

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(2);
    // Most recent should come first
    expect(result.data[0].description).toBe("Primeiro veículo");
    expect(result.data[1].description).toBe("Segundo veículo");
  });

  it("should return empty list when no activities match criteria", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listRecentActivitiesUseCase.execute({
        userId: "non-existing-user-id",
        userRole: "BUSINESS_ADMIN",
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if repository fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    vi.spyOn(activityInMemory, "listRecentActivities").mockRejectedValue(
      new Error("Database connection failed"),
    );

    await expect(
      listRecentActivitiesUseCase.execute({
        userId: createdUser.id,
        userRole: "BUSINESS_ADMIN",
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should include mock user data in response", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    await activityInMemory.createActivity({
      type: "vehicle",
      action: "create",
      entityId: "vehicle-1",
      description: "Veículo criado",
      status: "Completo",
      performedBy: "user-abc",
      businessId: "business-123",
      visibilityLevel: "COMPANY",
      performingUserRole: "BUSINESS_USER",
    });

    const result = await listRecentActivitiesUseCase.execute({
      userId: createdUser.id,
      userRole: "BUSINESS_ADMIN",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(1);
    const activity = result.data[0];

    expect(activity.userEmail).toBe("userabc@test.com"); // Based on performedBy last 3 chars
    expect(activity.userName).toBe("Test User abc");

    expect(activity.userRole).toBe("BUSINESS_USER");
    expect(activity.business_name).toBe("Test Business");
  });
});
