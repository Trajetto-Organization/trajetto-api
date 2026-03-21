import { describe, it, expect, beforeEach, vi } from "vitest";

import { CreatePartUseCase } from "@/modules/part/usecases/create-part/create-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { PartAlreadyExistsError } from "@/modules/part/usecases/errors/part-already-exists-error";

import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Create Part UseCase", () => {
  let partInMemory: InMemoryPartRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let supplierInMemory: InMemorySupplierRepository;

  let notificationService: NotificationService;
  let createPartUseCase: CreatePartUseCase;

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

    createPartUseCase = new CreatePartUseCase(
      userInMemory,
      businessInMemory,
      supplierInMemory,
      partInMemory,
      notificationService,
    );
  });

  it("should be able to create a part", async () => {
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
      description: "Filtro de Óleo",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part = await createPartUseCase.execute(partData, user.id);

    expect(part).toHaveProperty("id");
    expect(part.description).toBe("Filtro de Óleo");

    expect(Number(part.unit_price)).toBe(25.99);
    expect(part.businessId).toBe(business.id);

    expect(part.supplierId).toBeNull();
  });

  it("should be able to create a part with supplier", async () => {
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

    const partData = {
      description: "Vela de Ignição",
      unit_price: 45.5,
      businessId: business.id as string,
      supplierId: supplier.id,
    };

    const part = await createPartUseCase.execute(partData, user.id);

    expect(part).toHaveProperty("id");
    expect(part.description).toBe("Vela de Ignição");

    expect(Number(part.unit_price)).toBe(45.5);

    expect(part.businessId).toBe(business.id);
    expect(part.supplierId).toBe(supplier.id);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const partData = {
      description: "Filtro de Ar",
      unit_price: 15.99,
      businessId: "business-id",
    };

    await expect(
      createPartUseCase.execute(partData, "non-existent-user-id"),
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

    const partData = {
      description: "Filtro de Combustível",
      unit_price: 35.99,
      businessId: "non-existent-business-id",
    };

    await expect(
      createPartUseCase.execute(partData, user.id),
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
      description: "Pastilha de Freio",
      unit_price: 85.99,
      businessId: business.id as string,
      supplierId: "non-existent-supplier-id",
    };

    await expect(
      createPartUseCase.execute(partData, user.id),
    ).rejects.toBeInstanceOf(SupplierNotFoundError);
  });

  it("should throw SupplierNotBelongBusinessError if supplier does not belong to business", async () => {
    const businessData1 = {
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

    const businessData2 = {
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

    const business1 = await businessInMemory.createBusiness(businessData1);
    const business2 = await businessInMemory.createBusiness(businessData2);

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
      description: "Amortecedor",
      unit_price: 150.99,
      businessId: business1.id as string,
      supplierId: supplier.id,
    };

    await expect(
      createPartUseCase.execute(partData, user.id),
    ).rejects.toBeInstanceOf(SupplierNotBelongBusinessError);
  });

  it("should throw PartAlreadyExistsError if part description already exists in business", async () => {
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
      description: "Filtro de Óleo",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(existingPartData);

    const newPartData = {
      description: "Filtro de Óleo",
      unit_price: 30.99,
      businessId: business.id as string,
    };

    await expect(
      createPartUseCase.execute(newPartData, user.id),
    ).rejects.toBeInstanceOf(PartAlreadyExistsError);
  });

  it("should allow same part description in different businesses", async () => {
    const businessData1 = {
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

    const businessData2 = {
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

    const business1 = await businessInMemory.createBusiness(businessData1);
    const business2 = await businessInMemory.createBusiness(businessData2);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business2.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partDataBusiness1 = {
      description: "Filtro de Óleo",
      unit_price: 25.99,
      businessId: business1.id as string,
    };

    await partInMemory.createPart(partDataBusiness1);

    const partDataBusiness2 = {
      description: "Filtro de Óleo",
      unit_price: 30.99,
      businessId: business2.id as string,
    };

    const part = await createPartUseCase.execute(partDataBusiness2, user.id);

    expect(part.description).toBe("Filtro de Óleo");
    expect(part.businessId).toBe(business2.id);

    expect(Number(part.unit_price)).toBe(30.99);
  });

  it("should throw an AppError if an error occurs while creating the part", async () => {
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
      description: "Filtro de Óleo",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    vi.spyOn(partInMemory, "createPart").mockImplementationOnce(async () => {
      throw new Error("DB failure");
    });

    await expect(createPartUseCase.execute(partData, user.id)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar criar a peça! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when creating part", async () => {
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

    const part = await createPartUseCase.execute(partData, user.id);
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Peça",
      action: "create",
      entityId: part.id,
      description: expect.stringContaining("Filtro Para Notificação"),
      status: "Completo",
      performedBy: user.id,
      businessId: business.id,
    });
  });
});
