import { describe, it, expect, beforeEach, vi } from "vitest";

import { CreateSupplierUseCase } from "@/modules/supplier/usecases/create-supplier/create-supplier-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { SupplierNameAlreadyExistsError } from "@/modules/supplier/usecases/errors/supplier-name-already-exists-error";
import { SupplierCnpjAlreadyExistsError } from "@/modules/supplier/usecases/errors/supplier-cnpj-already-exists-error";

import { SupplierEmailAlreadyExistsError } from "@/modules/supplier/usecases/errors/supplier-email-already-exists-error";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Create Supplier UseCase", () => {
  let supplierInMemory: InMemorySupplierRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let notificationService: NotificationService;

  let createSupplierUseCase: CreateSupplierUseCase;

  beforeEach(() => {
    supplierInMemory = new InMemorySupplierRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    createSupplierUseCase = new CreateSupplierUseCase(
      userInMemory,
      businessInMemory,
      supplierInMemory,
      notificationService,
    );
  });

  it("should be able to create a supplier", async () => {
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
      cep: "87654321",
      city: "Supplier City",
      uf: "SP",
      street: "Supplier Street",
      address_number: "456",
      complement: "Apto 1",
      telephone: "11987654321",
      email: "supplier@example.com",
      businessId: business.id as string,
    };

    const supplier = await createSupplierUseCase.execute(supplierData, user.id);

    expect(supplier).toHaveProperty("id");
    expect(supplier.name).toBe("Fornecedor Teste");

    expect(supplier.cnpj).toBe("98765432000199");
    expect(supplier.businessId).toBe(business.id);

    expect(supplier.email).toBe("supplier@example.com");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const supplierData = {
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      businessId: "business-id",
    };

    await expect(
      createSupplierUseCase.execute(supplierData, "non-existent-user-id"),
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

    const supplierData = {
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      businessId: "non-existent-business-id",
    };

    await expect(
      createSupplierUseCase.execute(supplierData, user.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw SupplierNameAlreadyExistsError if supplier name already exists in business", async () => {
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

    const existingSupplierData = {
      name: "Fornecedor Teste",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(existingSupplierData);

    const newSupplierData = {
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    await expect(
      createSupplierUseCase.execute(newSupplierData, user.id),
    ).rejects.toBeInstanceOf(SupplierNameAlreadyExistsError);
  });

  it("should throw SupplierCnpjAlreadyExistsError if supplier CNPJ already exists in business", async () => {
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

    const existingSupplierData = {
      name: "Fornecedor Existente",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(existingSupplierData);

    const newSupplierData = {
      name: "Fornecedor Novo",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    await expect(
      createSupplierUseCase.execute(newSupplierData, user.id),
    ).rejects.toBeInstanceOf(SupplierCnpjAlreadyExistsError);
  });

  it("should throw SupplierEmailAlreadyExistsError if supplier email already exists", async () => {
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

    const existingSupplierData = {
      name: "Fornecedor Existente",
      cnpj: "11111111000111",
      email: "supplier@example.com",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(existingSupplierData);

    const newSupplierData = {
      name: "Fornecedor Novo",
      cnpj: "98765432000199",
      email: "supplier@example.com",
      businessId: business.id as string,
    };

    await expect(
      createSupplierUseCase.execute(newSupplierData, user.id),
    ).rejects.toBeInstanceOf(SupplierEmailAlreadyExistsError);
  });

  it("should be able to create a supplier without optional fields", async () => {
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
      name: "Fornecedor Simples",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    const supplier = await createSupplierUseCase.execute(supplierData, user.id);

    expect(supplier).toHaveProperty("id");

    expect(supplier.name).toBe("Fornecedor Simples");
    expect(supplier.cnpj).toBe("98765432000199");

    expect(supplier.businessId).toBe(business.id);

    expect(supplier.email).toBeNull();
    expect(supplier.cep).toBeNull();

    expect(supplier.city).toBeNull();
    expect(supplier.uf).toBeNull();

    expect(supplier.street).toBeNull();
    expect(supplier.address_number).toBeNull();

    expect(supplier.complement).toBeNull();
    expect(supplier.telephone).toBeNull();
  });

  it("should be able to create a supplier without email", async () => {
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
      name: "Fornecedor Sem Email",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    const supplier = await createSupplierUseCase.execute(supplierData, user.id);

    expect(supplier).toHaveProperty("id");
    expect(supplier.name).toBe("Fornecedor Sem Email");

    expect(supplier.cnpj).toBe("98765432000199");
    expect(supplier.email).toBeNull();
  });

  it("should throw an AppError if an error occurs while creating the supplier", async () => {
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

    vi.spyOn(supplierInMemory, "createSupplier").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      createSupplierUseCase.execute(supplierData, user.id),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar criar o fornecedor! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
