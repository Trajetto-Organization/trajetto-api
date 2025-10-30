import { describe, it, expect, beforeEach, vi } from "vitest";

import { CreateActivityUseCase } from "@/modules/activity/usecases/create-activity/create-activity-usecase";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";

import { AppError } from "@/shared/errors/AppError";

describe("Create Activity UseCase", () => {
  let activityInMemory: InMemoryActivityRepository;
  let createActivityUseCase: CreateActivityUseCase;

  beforeEach(() => {
    activityInMemory = new InMemoryActivityRepository();
    createActivityUseCase = new CreateActivityUseCase(activityInMemory);
  });

  it("should be able to create an activity", async () => {
    const activityData = {
      type: "vehicle",
      action: "create",
      entityId: "vehicle-123",
      description: "Veículo criado com sucesso",
      status: "Completo",
      performedBy: "user-123",
      businessId: "business-123",
      visibilityLevel: "COMPANY",
      performingUserRole: "BUSINESS_ADMIN",
    };

    const result = await createActivityUseCase.execute(activityData);

    expect(result).toHaveProperty("id");

    expect(result.type).toBe(activityData.type);
    expect(result.action).toBe(activityData.action);

    expect(result.entityId).toBe(activityData.entityId);
    expect(result.description).toBe(activityData.description);

    expect(result.status).toBe(activityData.status);
    expect(result.performedBy).toBe(activityData.performedBy);

    expect(result.businessId).toBe(activityData.businessId);
    expect(result.visibilityLevel).toBe(activityData.visibilityLevel);

    expect(result.performingUserRole).toBe(activityData.performingUserRole);

    expect(result).toHaveProperty("created_at");
    expect(result).toHaveProperty("updated_at");

    // Verify activity was stored in repository
    expect(activityInMemory.activities).toHaveLength(1);
    expect(activityInMemory.activities[0].id).toBe(result.id);
  });

  it("should create activity with default visibilityLevel when not provided", async () => {
    const activityData = {
      type: "user",
      action: "update",
      entityId: "user-456",
      description: "Usuário atualizado",
      status: "Completo",
      performedBy: "user-789",
      businessId: "business-456",
    };

    const result = await createActivityUseCase.execute(activityData);

    expect(result.visibilityLevel).toBe("COMPANY"); // Default value
    expect(result.performingUserRole).toBeNull(); // Default to null when not provided
  });

  it("should be able to create activity with minimal data", async () => {
    const activityData = {
      type: "service-order",
      action: "delete",
      entityId: "so-789",
      description: "Ordem de serviço removida",
      status: "Cancelado",
      performedBy: "user-999",
      businessId: "business-789",
    };

    const result = await createActivityUseCase.execute(activityData);

    expect(result).toHaveProperty("id");
    expect(result.type).toBe("service-order");

    expect(result.action).toBe("delete");
    expect(result.status).toBe("Cancelado");

    expect(result.visibilityLevel).toBe("COMPANY");
    expect(result.performingUserRole).toBeNull();
  });

  it("should create activity with SYSTEM visibility level", async () => {
    const activityData = {
      type: "system",
      action: "backup",
      entityId: "system-001",
      description: "Backup automático realizado",
      status: "Completo",
      performedBy: "system",
      businessId: "business-123",
      visibilityLevel: "SYSTEM",
      performingUserRole: "SYSTEM",
    };

    const result = await createActivityUseCase.execute(activityData);

    expect(result.visibilityLevel).toBe("SYSTEM");
    expect(result.performingUserRole).toBe("SYSTEM");
  });

  it("should create activity with USER visibility level", async () => {
    const activityData = {
      type: "profile",
      action: "update",
      entityId: "profile-123",
      description: "Perfil pessoal atualizado",
      status: "Completo",
      performedBy: "user-123",
      businessId: "business-123",
      visibilityLevel: "USER",
      performingUserRole: "BUSINESS_USER",
    };

    const result = await createActivityUseCase.execute(activityData);

    expect(result.visibilityLevel).toBe("USER");
    expect(result.performingUserRole).toBe("BUSINESS_USER");
  });

  it("should handle different entity types", async () => {
    const entityTypes = [
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

    for (const type of entityTypes) {
      const activityData = {
        type,
        action: "create",
        entityId: `${type}-123`,
        description: `${type} criado`,
        status: "Completo",
        performedBy: "user-123",
        businessId: "business-123",
      };

      const result = await createActivityUseCase.execute(activityData);
      expect(result.type).toBe(type);
    }

    expect(activityInMemory.activities).toHaveLength(entityTypes.length);
  });

  it("should handle different action types", async () => {
    const actions = ["create", "update", "delete", "view", "export", "import"];

    for (const action of actions) {
      const activityData = {
        type: "vehicle",
        action,
        entityId: "vehicle-123",
        description: `Veículo ${action}`,
        status: "Completo",
        performedBy: "user-123",
        businessId: "business-123",
      };

      const result = await createActivityUseCase.execute(activityData);
      expect(result.action).toBe(action);
    }

    expect(activityInMemory.activities).toHaveLength(actions.length);
  });

  it("should handle different status values", async () => {
    const statuses = [
      "Completo",
      "Pendente",
      "Cancelado",
      "Em andamento",
      "Falha",
    ];

    for (const status of statuses) {
      const activityData = {
        type: "vehicle",
        action: "create",
        entityId: "vehicle-123",
        description: "Veículo processado",
        status,
        performedBy: "user-123",
        businessId: "business-123",
      };

      const result = await createActivityUseCase.execute(activityData);
      expect(result.status).toBe(status);
    }

    expect(activityInMemory.activities).toHaveLength(statuses.length);
  });

  it("should throw AppError if repository fails", async () => {
    const activityData = {
      type: "vehicle",
      action: "create",
      entityId: "vehicle-123",
      description: "Veículo criado",
      status: "Completo",
      performedBy: "user-123",
      businessId: "business-123",
    };

    vi.spyOn(activityInMemory, "createActivity").mockRejectedValue(
      new Error("Database connection failed"),
    );

    await expect(
      createActivityUseCase.execute(activityData),
    ).rejects.toBeInstanceOf(AppError);

    expect(activityInMemory.createActivity).toHaveBeenCalledWith(activityData);
  });

  it("should preserve all provided activity data", async () => {
    const timestamp = new Date();
    const activityData = {
      type: "maintenance",
      action: "schedule",
      entityId: "maintenance-001",
      description: "Manutenção preventiva agendada para veículo",
      status: "Agendado",
      performedBy: "user-maintenance",
      businessId: "business-transport",
      visibilityLevel: "COMPANY",
      performingUserRole: "MAINTENANCE_ADMIN",
    };

    const result = await createActivityUseCase.execute(activityData);

    // Verify all data is preserved
    Object.keys(activityData).forEach((key) => {
      expect(result[key as keyof typeof result]).toBe(
        activityData[key as keyof typeof activityData],
      );
    });

    // Verify timestamps are set
    expect(result.created_at).toBeInstanceOf(Date);
    expect(result.updated_at).toBeInstanceOf(Date);

    expect(new Date(result.created_at).getTime()).toBeGreaterThanOrEqual(
      timestamp.getTime(),
    );
  });

  it("should generate unique IDs for multiple activities", async () => {
    const activities = [];

    for (let i = 0; i < 5; i++) {
      const result = await createActivityUseCase.execute({
        type: "test",
        action: "create",
        entityId: `test-${i}`,
        description: `Test activity ${i}`,
        status: "Completo",
        performedBy: `user-${i}`,
        businessId: "business-test",
      });

      activities.push(result.id);
    }

    // All IDs should be unique
    const uniqueIds = new Set(activities);

    expect(uniqueIds.size).toBe(5);
    expect(activityInMemory.activities).toHaveLength(5);
  });
});
