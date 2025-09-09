import { describe, it, expect, beforeEach, vi } from "vitest";

import { GetDashboardOverviewUseCase } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryDashboardRepository } from "@/modules/dashboard/repositories/in-memory/in-memory-dashboard-repository";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

describe("Get Dashboard Overview UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let dashboardInMemory: InMemoryDashboardRepository;

  let activityInMemory: InMemoryActivityRepository;
  let getDashboardOverviewUseCase: GetDashboardOverviewUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    dashboardInMemory = new InMemoryDashboardRepository();

    activityInMemory = new InMemoryActivityRepository();
    getDashboardOverviewUseCase = new GetDashboardOverviewUseCase(
      userInMemory,
      dashboardInMemory,
      activityInMemory,
    );
  });

  it("should be able to get dashboard overview for MASTER user", async () => {
    const createdUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Setup test data in repository
    const today = new Date();
    const currentMonth =
      today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");
    const lastMonth =
      today.getMonth() === 0
        ? today.getFullYear() - 1 + "-12"
        : today.getFullYear() + "-" + String(today.getMonth()).padStart(2, "0");

    // Add entity counts for different entities
    [
      "vehicle",
      "driver",
      "business",
      "branch",
      "part",
      "supplier",
      "service-order",
      "user",
      "fine",
    ].forEach((entity) => {
      dashboardInMemory.addEntityCount(entity, 5, currentMonth + "-15");
      dashboardInMemory.addEntityCount(entity, 3, lastMonth + "-15");
    });

    dashboardInMemory.setVehicleStatus({
      ACTIVE: 10,
      INACTIVE: 5,
      BLOCKED: 2,
      IN_ROUTE: 3,
    });

    dashboardInMemory.setMaintenanceStats({
      pending: 3,
      recent: 7,
      overdue: 1,
    });

    dashboardInMemory.addVehicleType("Caminhão", 8);
    dashboardInMemory.addVehicleType("Van", 12);

    // Add monthly costs for 6 months
    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 15);
      const dateStr = date.toISOString().split("T")[0];
      dashboardInMemory.addMonthlyCost(1500, 800, dateStr);
    }

    // Add test activity data
    activityInMemory.addActivity({
      id: "activity-1",
      type: "vehicle",
      action: "create",
      entityId: "vehicle-1",
      description: "Veículo criado",
      status: "Completo",
      performedBy: "user-1",
      businessId: null, // MASTER user sees all activities
      created_at: "2024-01-01T10:00:00Z",
    });

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    expect(result).toHaveProperty("counts");
    expect(result).toHaveProperty("vehicleStatus");
    expect(result).toHaveProperty("activityTrends");
    expect(result).toHaveProperty("maintenanceStats");
    expect(result).toHaveProperty("recentActivity");
    expect(result).toHaveProperty("vehiclesByType");
    expect(result).toHaveProperty("maintenanceCosts");

    expect(result.counts.vehicles.currentMonth).toBe(5);
    expect(result.vehicleStatus.ACTIVE).toBe(10);
    expect(result.maintenanceStats.pending).toBe(3);
    expect(result.vehiclesByType).toHaveLength(2);
    expect(result.recentActivity).toHaveLength(1);
    expect(result.activityTrends).toHaveLength(6); // 6 months of trends
    expect(result.maintenanceCosts).toHaveLength(6); // 6 months of costs
  });

  it("should be able to get dashboard overview for BUSINESS_ADMIN user", async () => {
    const createdUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "password",
      name: "Business Admin",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "BUSINESS_ADMIN",
    });

    // Setup test data
    const today = new Date();
    const currentMonth =
      today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    [
      "vehicle",
      "driver",
      "branch",
      "part",
      "supplier",
      "service-order",
      "user",
      "fine",
    ].forEach((entity) => {
      dashboardInMemory.addEntityCount(
        entity,
        3,
        currentMonth + "-15",
        "business-id",
      );
    });

    dashboardInMemory.setVehicleStatus({
      ACTIVE: 5,
      INACTIVE: 2,
      BLOCKED: 0,
      IN_ROUTE: 1,
    });

    dashboardInMemory.setMaintenanceStats({
      pending: 1,
      recent: 3,
      overdue: 0,
    });

    dashboardInMemory.addVehicleType("Van", 8, "business-id");

    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 15);
      const dateStr = date.toISOString().split("T")[0];
      dashboardInMemory.addMonthlyCost(500, 200, dateStr, "business-id");
    }

    // No additional activities for BUSINESS_ADMIN test

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    expect(result.counts.businesses.currentMonth).toBe(0); // BUSINESS_ADMIN can't see businesses
    expect(result.counts.vehicles.currentMonth).toBe(3);

    expect(result.vehicleStatus.ACTIVE).toBe(5);
  });

  it("should be able to get dashboard overview for BUSINESS_USER with permissions", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "BUSINESS_USER",
    });

    // Mock user with permissions
    createdUser.profileAccess = {
      id: "profile-id",
      name: "Test Profile",
      businessId: "business-id",
      permissions: [
        {
          id: "perm-1",
          permissionKey: "vehicle_manage",
          canRead: true,
          canWrite: false,
        },
        {
          id: "perm-2",
          permissionKey: "driver_manage",
          canRead: true,
          canWrite: true,
        },
      ],
    } as any;

    // Setup test data
    const today = new Date();
    const currentMonth =
      today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    ["vehicle", "driver"].forEach((entity) => {
      dashboardInMemory.addEntityCount(
        entity,
        2,
        currentMonth + "-15",
        "business-id",
      );
    });

    dashboardInMemory.setVehicleStatus({
      ACTIVE: 3,
      INACTIVE: 1,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });

    dashboardInMemory.setMaintenanceStats({
      pending: 0,
      recent: 1,
      overdue: 0,
    });

    dashboardInMemory.addVehicleType("Carro", 4, "business-id");

    // No additional activities for BUSINESS_USER with permissions test

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    expect(result.counts.vehicles.currentMonth).toBe(2); // Has vehicle permission
    expect(result.counts.drivers.currentMonth).toBe(2); // Has driver permission

    expect(result.counts.businesses.currentMonth).toBe(0); // No business permission
    expect(result.counts.branches.currentMonth).toBe(0); // No branch permission
  });

  it("should be able to get dashboard overview for BUSINESS_USER without permissions", async () => {
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

    // No additional activities for no permissions test

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    // All counts should be 0 due to no permissions
    expect(result.counts.vehicles.currentMonth).toBe(0);
    expect(result.counts.drivers.currentMonth).toBe(0);

    expect(result.counts.businesses.currentMonth).toBe(0);
    expect(result.counts.branches.currentMonth).toBe(0);

    expect(result.counts.parts.currentMonth).toBe(0);
    expect(result.counts.suppliers.currentMonth).toBe(0);

    expect(result.counts.serviceOrders.currentMonth).toBe(0);
    expect(result.counts.users.currentMonth).toBe(0);

    expect(result.counts.fines.currentMonth).toBe(0);

    // Vehicle status should be default values
    expect(result.vehicleStatus).toEqual({
      ACTIVE: 0,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });

    // Maintenance stats should be default values
    expect(result.maintenanceStats).toEqual({
      pending: 0,
      recent: 0,
      overdue: 0,
    });

    expect(result.vehiclesByType).toEqual([]);
    expect(result.maintenanceCosts).toEqual([]);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      getDashboardOverviewUseCase.execute({
        userId: "non-existing-user-id",
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

    vi.spyOn(dashboardInMemory, "countByDateRange").mockRejectedValue(
      new Error("Database connection failed"),
    );

    await expect(
      getDashboardOverviewUseCase.execute({
        userId: createdUser.id,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should throw AppError if activity repository fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Setup basic data
    const today = new Date();
    const currentMonth =
      today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    dashboardInMemory.addEntityCount("vehicle", 1, currentMonth + "-15");

    dashboardInMemory.setVehicleStatus({
      ACTIVE: 0,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });

    dashboardInMemory.setMaintenanceStats({
      pending: 0,
      recent: 0,
      overdue: 0,
    });

    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 15);
      const dateStr = date.toISOString().split("T")[0];
      dashboardInMemory.addMonthlyCost(0, 0, dateStr);
    }

    vi.spyOn(activityInMemory, "listRecentActivities").mockRejectedValue(
      new Error("Activity fetch failed"),
    );

    await expect(
      getDashboardOverviewUseCase.execute({
        userId: createdUser.id,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should handle null profileAccess gracefully for BUSINESS_USER", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "BUSINESS_USER",
    });

    createdUser.profileAccess = null as any;

    // No additional activities for null profileAccess test

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    // Should return all zeros due to no permissions
    expect(result.counts.vehicles.currentMonth).toBe(0);
    expect(result.counts.drivers.currentMonth).toBe(0);
  });

  it("should format recent activity data correctly", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Setup minimal data
    const today = new Date();
    const currentMonth =
      today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    dashboardInMemory.addEntityCount("vehicle", 0, currentMonth + "-15");
    dashboardInMemory.setVehicleStatus({
      ACTIVE: 0,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });

    dashboardInMemory.setMaintenanceStats({
      pending: 0,
      recent: 0,
      overdue: 0,
    });

    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 15);
      const dateStr = date.toISOString().split("T")[0];

      dashboardInMemory.addMonthlyCost(0, 0, dateStr);
    }

    // Add activity with null/undefined values for testing formatting
    activityInMemory.addActivity({
      id: "activity-1",
      type: "vehicle",
      action: "create",
      entityId: "vehicle-1",
      description: "Test activity",
      status: "Completo",
      performedBy: "user-1",
      businessId: null,
      created_at: "2024-01-01T10:00:00Z",
    });

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    expect(result.recentActivity[0]).toEqual({
      id: "activity-1",
      type: "Vehicle", // Should capitalize first letter
      description: "Test activity",
      userEmail: "userr-1@test.com", // Mock data from InMemoryActivityRepository (last 3 chars of userId)
      userName: "Test User r-1", // Mock data from InMemoryActivityRepository
      userRole: "MASTER", // User role from test
      business_name: "N/A", // Formatted to N/A when null
      date: "2024-01-01T10:00:00Z",
      status: "Completo",
    });
  });

  it("should generate correct activity trends for 6 months", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    // Setup data for 6 months
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

    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 15);
      const dateStr = date.toISOString().split("T")[0];

      entities.forEach((entity) => {
        dashboardInMemory.addEntityCount(entity, 1, dateStr);
      });

      dashboardInMemory.addMonthlyCost(100, 50, dateStr);
    }

    dashboardInMemory.setVehicleStatus({
      ACTIVE: 0,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });

    dashboardInMemory.setMaintenanceStats({
      pending: 0,
      recent: 0,
      overdue: 0,
    });

    // No additional activities for 6 months trends test

    const result = await getDashboardOverviewUseCase.execute({
      userId: createdUser.id,
    });

    expect(result.activityTrends).toHaveLength(6);
    expect(result.maintenanceCosts).toHaveLength(6);

    // Check that each trend has the expected structure
    result.activityTrends.forEach((trend) => {
      expect(trend).toHaveProperty("month");
      expect(trend).toHaveProperty("vehicles");
      expect(trend).toHaveProperty("drivers");
      expect(trend).toHaveProperty("businesses");
      expect(trend).toHaveProperty("branches");
      expect(trend).toHaveProperty("parts");
      expect(trend).toHaveProperty("suppliers");
      expect(trend).toHaveProperty("serviceOrders");
      expect(trend).toHaveProperty("users");
      expect(trend).toHaveProperty("fines");
    });

    result.maintenanceCosts.forEach((cost) => {
      expect(cost).toHaveProperty("month");
      expect(cost).toHaveProperty("preventive");
      expect(cost).toHaveProperty("corrective");
      expect(cost.preventive).toBe(100);
      expect(cost.corrective).toBe(50);
    });
  });
});
