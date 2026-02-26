import { describe, it, expect, beforeEach, vi } from "vitest";
import { UpdatePartUseCase } from "@/modules/part/usecases/update-part/update-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { PartNotFoundError } from "@/modules/part/usecases/errors/part-not-found-error";
import { PartAlreadyExistsError } from "@/modules/part/usecases/errors/part-already-exists-error";

import { PartNotBelongError } from "@/modules/part/usecases/errors/part-not-belong-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Update Part UseCase", () => {
  let partInMemory: InMemoryPartRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let supplierInMemory: InMemorySupplierRepository;

  let notificationService: NotificationService;
  let updatePartUseCase: UpdatePartUseCase;

  beforeEach(() => {
    partInMemory = new InMemoryPartRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    supplierInMemory = new InMemorySupplierRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updatePartUseCase = new UpdatePartUseCase(
      userInMemory,
      businessInMemory,
      supplierInMemory,
      partInMemory,
      notificationService,
    );
  });

  it("should be able to update a part", async () => {
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

    const originalPartData = {
      description: "Filtro Original",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(originalPartData);

    const updateData = {
      description: "Filtro Atualizado",
      unit_price: 35.5,
    };

    const updatedPart = await updatePartUseCase.execute(
      updateData,
      part.id,
      user.id,
      business.id as string,
    );

    expect(updatedPart.id).toBe(part.id);
    expect(updatedPart.description).toBe("Filtro Atualizado");

    expect(Number(updatedPart.unit_price)).toBe(35.5);
    expect(updatedPart.businessId).toBe(business.id);
  });

  it("should be able to update part with supplier", async () => {
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

    const supplierData = {
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const originalPartData = {
      description: "Vela Original",
      unit_price: 45.0,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(originalPartData);

    const updateData = {
      description: "Vela Atualizada",
      unit_price: 55.0,
      supplierId: supplier.id,
    };

    const updatedPart = await updatePartUseCase.execute(
      updateData,
      part.id,
      user.id,
      business.id as string,
    );

    expect(updatedPart.description).toBe("Vela Atualizada");
    expect(Number(updatedPart.unit_price)).toBe(55.0);

    expect(updatedPart.supplierId).toBe(supplier.id);
    expect(updatedPart.businessId).toBe(business.id);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const updateData = { description: "Updated Description" };

    await expect(
      updatePartUseCase.execute(
        updateData,
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

    const updateData = { description: "Updated Description" };

    await expect(
      updatePartUseCase.execute(
        updateData,
        "part-id",
        user.id,
        "non-existent-business-id",
      ),
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

    const updateData = { description: "Updated Description" };

    await expect(
      updatePartUseCase.execute(
        updateData,
        "non-existent-part-id",
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(PartNotFoundError);
  });

  it("should throw PartNotBelongError if part does not belong to current business", async () => {
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

    const updateData = { description: "Updated Description" };

    await expect(
      updatePartUseCase.execute(
        updateData,
        part.id,
        user.id,
        business2.id as string,
      ),
    ).rejects.toBeInstanceOf(PartNotBelongError);
  });

  it("should be able to change part business", async () => {
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
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Para Transfer",
      unit_price: 25.99,
      businessId: business1.id as string,
    };

    const part = await partInMemory.createPart(partData);

    const updateData = {
      description: "Peça Transferida",
      businessId: business2.id,
    };

    const updatedPart = await updatePartUseCase.execute(
      updateData,
      part.id,
      user.id,
      business1.id as string,
    );

    expect(updatedPart.description).toBe("Peça Transferida");
    expect(updatedPart.businessId).toBe(business2.id);
  });

  it("should throw BusinessNotFoundError if new business does not exist when changing business", async () => {
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

    const updateData = {
      businessId: "non-existent-business-id",
    };

    await expect(
      updatePartUseCase.execute(
        updateData,
        part.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw SupplierNotFoundError if supplier is not found", async () => {
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

    const updateData = {
      supplierId: "non-existent-supplier-id",
    };

    await expect(
      updatePartUseCase.execute(
        updateData,
        part.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(SupplierNotFoundError);
  });

  it("should throw SupplierNotBelongBusinessError if supplier does not belong to target business", async () => {
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
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const supplierData = {
      name: "Fornecedor Business 2",
      cnpj: "98765432000199",
      businessId: business2.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const partData = {
      description: "Peça Teste",
      unit_price: 25.99,
      businessId: business1.id as string,
    };

    const part = await partInMemory.createPart(partData);

    const updateData = {
      supplierId: supplier.id,
    };

    await expect(
      updatePartUseCase.execute(
        updateData,
        part.id,
        user.id,
        business1.id as string,
      ),
    ).rejects.toBeInstanceOf(SupplierNotBelongBusinessError);
  });

  it("should throw PartAlreadyExistsError if description already exists in target business", async () => {
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

    const existingPartData = {
      description: "Filtro Existente",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(existingPartData);

    const partToUpdateData = {
      description: "Filtro Para Atualizar",
      unit_price: 30.99,
      businessId: business.id as string,
    };

    const partToUpdate = await partInMemory.createPart(partToUpdateData);

    const updateData = {
      description: "Filtro Existente",
    };

    await expect(
      updatePartUseCase.execute(
        updateData,
        partToUpdate.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(PartAlreadyExistsError);
  });

  it("should allow updating part with same current description", async () => {
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
      description: "Filtro Teste",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    const updateData = {
      description: "Filtro Teste",
      unit_price: 35.99,
    };

    const updatedPart = await updatePartUseCase.execute(
      updateData,
      part.id,
      user.id,
      business.id as string,
    );

    expect(updatedPart.description).toBe("Filtro Teste");
    expect(Number(updatedPart.unit_price)).toBe(35.99);
  });

  it("should throw an AppError if an error occurs while updating the part", async () => {
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
      description: "Filtro Teste",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);
    const updateData = { description: "Updated Description" };

    vi.spyOn(partInMemory, "updatePart").mockImplementationOnce(async () => {
      throw new Error("DB failure");
    });

    await expect(
      updatePartUseCase.execute(
        updateData,
        part.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar a peça! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when updating part", async () => {
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
      description: "Filtro Para Notificação",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await partInMemory.createPart(partData);

    const updateData = {
      description: "Filtro Notificação Atualizado",
      unit_price: 35.99,
    };

    const updatedPart = await updatePartUseCase.execute(
      updateData,
      part.id,
      user.id,
      business.id as string,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Peça",
      action: "update",
      entityId: updatedPart.id,
      description: expect.stringContaining("Filtro Notificação Atualizado"),
      status: "Atualizado",
      performedBy: user.id,
      businessId: business.id,
    });
  });
});
