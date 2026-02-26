import { describe, it, expect, beforeEach, vi } from "vitest";

import { GetDashboardTrendsUseCase } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDashboardRepository } from "@/modules/dashboard/repositories/in-memory/in-memory-dashboard-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

describe("Get Dashboard Trends UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let dashboardInMemory: InMemoryDashboardRepository;

  let getDashboardTrendsUseCase: GetDashboardTrendsUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    dashboardInMemory = new InMemoryDashboardRepository();

    getDashboardTrendsUseCase = new GetDashboardTrendsUseCase(
      userInMemory,
      dashboardInMemory,
    );
  });

  it("should be able to get dashboard trends for 7 days period", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Setup test data for 7 days
    // Use the same date construction approach as the use case (getCurrentDateLocal + formatDateToLocal)
    // to avoid timezone mismatches between test data and use case queries
    const now = new Date();
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const entities = [
      "vehicle",
      "driver",
      "business",
      "branch",
      "part",
      "supplier",
      "service-order",
      "user",
      "fine",
    ];

    for (let i = 0; i < 7; i++) {
      const date = new Date(todayLocal);

      date.setDate(todayLocal.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];

      entities.forEach((entity) => {
        dashboardInMemory.addEntityCount(entity, 2, dateStr);
      });

      dashboardInMemory.addMonthlyCost(300, 150, dateStr);
    }

    const result = await getDashboardTrendsUseCase.execute({
      userId: createdUser.id,
      period: "7d",
    });

    expect(result).toHaveProperty("activityTrends");
    expect(result).toHaveProperty("maintenanceCosts");

    expect(result.activityTrends).toHaveLength(7); // 7 days
    expect(result.maintenanceCosts).toHaveLength(7); // 7 days

    // Check daily format
    result.activityTrends.forEach((trend) => {
      expect(trend).toHaveProperty("date");
      expect(trend).toHaveProperty("vehicles");

      expect(trend).toHaveProperty("drivers");
      expect(trend).toHaveProperty("businesses");

      expect(trend).toHaveProperty("branches");
      expect(trend).toHaveProperty("parts");

      expect(trend).toHaveProperty("suppliers");
      expect(trend).toHaveProperty("serviceOrders");

      expect(trend).toHaveProperty("users");
      expect(trend).toHaveProperty("fines");

      expect(trend.vehicles).toBe(2);
    });

    result.maintenanceCosts.forEach((cost) => {
      expect(cost).toHaveProperty("date");
      expect(cost).toHaveProperty("preventive");

      expect(cost).toHaveProperty("corrective");
      expect(cost.preventive).toBe(300);

      expect(cost.corrective).toBe(150);
    });
  });

  it("should handle BUSINESS_USER without permissions correctly", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "BUSINESS_USER",
    });

    // Mock user without permissions
    createdUser.profileAccess = {
      id: "profile-id",
      name: "Limited Profile",
      businessId: "business-id",
      permissions: [],
    } as any;

    // Setup test data for 7 days (but user won't see it due to no permissions)
    const today = new Date();
    const entities = [
      "vehicle",
      "driver",
      "business",
      "branch",
      "part",
      "supplier",
      "service-order",
      "user",
      "fine",
    ];

    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];

      entities.forEach((entity) => {
        dashboardInMemory.addEntityCount(entity, 5, dateStr);
      });
    }

    const result = await getDashboardTrendsUseCase.execute({
      userId: createdUser.id,
      period: "7d",
    });

    expect(result.activityTrends).toHaveLength(7);
    expect(result.maintenanceCosts).toHaveLength(0); // Should be empty array due to no service_order_manage permission

    // All entity counts should be 0 due to no permissions
    result.activityTrends.forEach((trend) => {
      expect(trend.vehicles).toBe(0);
      expect(trend.drivers).toBe(0);

      expect(trend.businesses).toBe(0);
      expect(trend.branches).toBe(0);

      expect(trend.parts).toBe(0);
      expect(trend.suppliers).toBe(0);

      expect(trend.serviceOrders).toBe(0);
      expect(trend.users).toBe(0);

      expect(trend.fines).toBe(0);
    });

    // Maintenance costs array should be empty due to no service_order_manage permission
    expect(result.maintenanceCosts).toEqual([]);
  });

  it("should correctly format dates for daily periods", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Setup test data for 7 days
    const today = new Date();
    const entities = [
      "vehicle",
      "driver",
      "business",
      "branch",
      "part",
      "supplier",
      "service-order",
      "user",
      "fine",
    ];

    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];

      entities.forEach((entity) => {
        dashboardInMemory.addEntityCount(entity, 0, dateStr);
      });

      dashboardInMemory.addMonthlyCost(0, 0, dateStr);
    }

    const result = await getDashboardTrendsUseCase.execute({
      userId: createdUser.id,
      period: "7d",
    });

    // Should have PT-BR formatted dates like "03 de set.", "04 de set.", etc.
    result.activityTrends.forEach((trend) => {
      expect(trend.date).toMatch(/^\d{2} de \w{3}\.$/);
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      getDashboardTrendsUseCase.execute({
        userId: "non-existing-user-id",
        period: "7d",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if dashboard repository fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Mock the repository to throw an error
    vi.spyOn(dashboardInMemory, "countByDateRange").mockRejectedValue(
      new Error("Database connection failed"),
    );

    await expect(
      getDashboardTrendsUseCase.execute({
        userId: createdUser.id,
        period: "7d",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
