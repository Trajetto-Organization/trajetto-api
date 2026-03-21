import { describe, it, expect, beforeEach, vi } from "vitest";

import { DeletePartUseCase } from "@/modules/part/usecases/delete-part/delete-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { PartNotFoundError } from "@/modules/part/usecases/errors/part-not-found-error";

import { PartNotBelongServiceOrderError } from "@/modules/part/usecases/errors/part-not-belong-service-order-error";
import { PartHasAssociatedServiceOrderPartsError } from "@/modules/part/usecases/errors/part-has-associated-service-order-parts-error";

import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Delete Part UseCase", () => {
  let partInMemory: InMemoryPartRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;

  let notificationService: NotificationService;
  let deletePartUseCase: DeletePartUseCase;

  beforeEach(() => {
    partInMemory = new InMemoryPartRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deletePartUseCase = new DeletePartUseCase(
      userInMemory,
      businessInMemory,
      partInMemory,
      notificationService,
    );
  });

  it("should be able to delete a part", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Filtro Para Deletar",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    const deletedPart = await deletePartUseCase.execute(
      part.id,
      user.id,
      business.id as string,
    );

    expect(deletedPart.id).toBe(part.id);
    expect(deletedPart.description).toBe("Filtro Para Deletar");

    expect(Number(deletedPart.unit_price)).toBe(25.99);
    expect(deletedPart.businessId).toBe(business.id);

    const partExists = await partInMemory.findPartById(part.id);
    expect(partExists).toBeNull();
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      deletePartUseCase.execute(
        "part-id",
        "non-existent-user-id",
        "business-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business is not found", async () => {
    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: "business-id",
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    await expect(
      deletePartUseCase.execute("part-id", user.id, "non-existent-business-id"),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw PartNotFoundError if part is not found", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    await expect(
      deletePartUseCase.execute(
        "non-existent-part-id",
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(PartNotFoundError);
  });

  it("should throw PartNotBelongServiceOrderError if part does not belong to business", async () => {
    const business1Data = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business2Data = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000111",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "RJ",
      street: "Test Street 2",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Person 2",
      erp_code: "ERP456",
    };

    const business1 = await businessInMemory.createBusiness(business1Data);
    const business2 = await businessInMemory.createBusiness(business2Data);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business2.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Business 1",
      unit_price: 25.99,
      businessId: business1.id as string,
    };

    const part = await partInMemory.createPart(partData);

    await expect(
      deletePartUseCase.execute(part.id, user.id, business2.id as string),
    ).rejects.toBeInstanceOf(PartNotBelongServiceOrderError);
  });

  it("should throw PartHasAssociatedServiceOrderPartsError if part is used in service orders", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Com Ordem de Serviço",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    // Mock the method to simulate parts associated with service orders
    vi.spyOn(partInMemory, "findServiceOrderPartsByPartId").mockResolvedValue([
      { id: "service-order-part-1" } as any,
      { id: "service-order-part-2" } as any,
    ]);

    await expect(
      deletePartUseCase.execute(part.id, user.id, business.id as string),
    ).rejects.toBeInstanceOf(PartHasAssociatedServiceOrderPartsError);
  });

  it("should delete part and verify it's actually removed from repository", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const part1Data = {
      description: "Peça 1",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part2Data = {
      description: "Peça 2",
      unit_price: 35.99,
      businessId: business.id as string,
    };

    const part1 = await partInMemory.createPart(part1Data);
    const part2 = await partInMemory.createPart(part2Data);

    expect(partInMemory.parts.length).toBe(2);

    await deletePartUseCase.execute(part1.id, user.id, business.id as string);

    expect(partInMemory.parts.length).toBe(1);
    expect(partInMemory.parts[0].id).toBe(part2.id);

    const deletedPartCheck = await partInMemory.findPartById(part1.id);
    expect(deletedPartCheck).toBeNull();

    const remainingPartCheck = await partInMemory.findPartById(part2.id);

    expect(remainingPartCheck).not.toBeNull();
    expect(remainingPartCheck?.description).toBe("Peça 2");
  });

  it("should delete part with supplier successfully", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Com Fornecedor",
      unit_price: 45.99,
      businessId: business.id as string,
      supplierId: "supplier-id",
    };

    const part = await partInMemory.createPart(partData);

    const deletedPart = await deletePartUseCase.execute(
      part.id,
      user.id,
      business.id as string,
    );

    expect(deletedPart.supplierId).toBe("supplier-id");
    expect(deletedPart.description).toBe("Peça Com Fornecedor");

    const partExists = await partInMemory.findPartById(part.id);
    expect(partExists).toBeNull();
  });

  it("should throw an AppError if an error occurs while deleting the part", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Teste",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    vi.spyOn(partInMemory, "deletePart").mockImplementationOnce(async () => {
      throw new Error("DB failure");
    });

    await expect(
      deletePartUseCase.execute(part.id, user.id, business.id as string),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar deletar a peça! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when deleting part", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Para Notificação",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    const deletedPart = await deletePartUseCase.execute(
      part.id,
      user.id,
      business.id as string,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Peça",
      action: "delete",
      entityId: deletedPart.id,
      description: expect.stringContaining("Peça Para Notificação"),
      status: "Deletado",
      performedBy: user.id,
      businessId: business.id,
    });
  });

  it("should handle edge case with high service order parts count", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Popular",
      unit_price: 15.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    // Mock many associated service order parts
    const manyAssociatedParts = Array.from({ length: 25 }, (_, i) => ({
      id: `service-order-part-${i + 1}`,
    }));
    vi.spyOn(partInMemory, "findServiceOrderPartsByPartId").mockResolvedValue(
      manyAssociatedParts as any,
    );

    const error = await deletePartUseCase
      .execute(part.id, user.id, business.id as string)
      .catch((err) => err);

    expect(error).toBeInstanceOf(PartHasAssociatedServiceOrderPartsError);
    expect(error.message).toContain("25 ordem(ns) de serviço");
  });
});
