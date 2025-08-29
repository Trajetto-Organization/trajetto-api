import { describe, it, expect, beforeEach, vi } from "vitest";

import { UpdateSupplierUseCase } from "@/modules/supplier/usecases/update-supplier/update-supplier-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

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

describe("Update Supplier UseCase", () => {
  let supplierInMemory: InMemorySupplierRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let notificationService: NotificationService;

  let updateSupplierUseCase: UpdateSupplierUseCase;

  beforeEach(() => {
    supplierInMemory = new InMemorySupplierRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updateSupplierUseCase = new UpdateSupplierUseCase(
      userInMemory,
      businessInMemory,
      supplierInMemory,
      notificationService,
    );
  });

  it("should be able to update a supplier", async () => {
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
      name: "Fornecedor Original",
      cnpj: "98765432000199",
      email: "original@example.com",
      businessId: business.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const updateData = {
      name: "Fornecedor Atualizado",
      email: "updated@example.com",
      telephone: "11987654321",
    };

    const updatedSupplier = await updateSupplierUseCase.execute(
      updateData,
      supplier.id,
      business.id as string,
      user.id,
    );

    expect(updatedSupplier.id).toBe(supplier.id);
    expect(updatedSupplier.name).toBe("Fornecedor Atualizado");

    expect(updatedSupplier.email).toBe("updated@example.com");
    expect(updatedSupplier.telephone).toBe("11987654321");

    expect(updatedSupplier.cnpj).toBe("98765432000199");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const updateData = { name: "Updated Name" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        "supplier-id",
        "business-id",
        "non-existent-user-id",
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

    const updateData = { name: "Updated Name" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        "supplier-id",
        "non-existent-business-id",
        user.id,
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

    const updateData = { name: "Updated Name" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        "non-existent-supplier-id",
        business.id as string,
        user.id,
      ),
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
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      businessId: business1.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const updateData = { name: "Updated Name" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        supplier.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(SupplierNotBelongBusinessError);
  });

  it("should allow MASTER user to update supplier from different business", async () => {
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
      email: "master@example.com",
      password: await hash("password", 6),
      name: "Master User",
      role: "MASTER" as UserRole,
      businessId: business2.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const supplierData = {
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      businessId: business1.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const updateData = { name: "Updated Name" };

    const updatedSupplier = await updateSupplierUseCase.execute(
      updateData,
      supplier.id,
      business2.id as string,
      user.id,
    );

    expect(updatedSupplier.name).toBe("Updated Name");
    expect(updatedSupplier.businessId).toBe(business2.id);
  });

  it("should throw SupplierNameAlreadyExistsError if name already exists in business", async () => {
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

    const supplier1Data = {
      name: "Fornecedor Existente",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    const supplier2Data = {
      name: "Fornecedor Para Atualizar",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    const supplier2 = await supplierInMemory.createSupplier(supplier2Data);

    const updateData = { name: "Fornecedor Existente" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        supplier2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(SupplierNameAlreadyExistsError);
  });

  it("should throw SupplierCnpjAlreadyExistsError if CNPJ already exists in business", async () => {
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

    const supplier1Data = {
      name: "Fornecedor 1",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    const supplier2Data = {
      name: "Fornecedor 2",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    const supplier2 = await supplierInMemory.createSupplier(supplier2Data);

    const updateData = { cnpj: "11111111000111" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        supplier2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(SupplierCnpjAlreadyExistsError);
  });

  it("should throw SupplierEmailAlreadyExistsError if email already exists", async () => {
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

    const supplier1Data = {
      name: "Fornecedor 1",
      cnpj: "11111111000111",
      email: "existing@example.com",
      businessId: business.id as string,
    };

    const supplier2Data = {
      name: "Fornecedor 2",
      cnpj: "98765432000199",
      email: "other@example.com",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    const supplier2 = await supplierInMemory.createSupplier(supplier2Data);

    const updateData = { email: "existing@example.com" };

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        supplier2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(SupplierEmailAlreadyExistsError);
  });

  it("should allow updating supplier with same current values", async () => {
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
      email: "supplier@example.com",
      businessId: business.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const updateData = {
      name: "Fornecedor Teste",
      cnpj: "98765432000199",
      email: "supplier@example.com",
    };

    const updatedSupplier = await updateSupplierUseCase.execute(
      updateData,
      supplier.id,
      business.id as string,
      user.id,
    );

    expect(updatedSupplier.name).toBe("Fornecedor Teste");
    expect(updatedSupplier.cnpj).toBe("98765432000199");

    expect(updatedSupplier.email).toBe("supplier@example.com");
  });

  it("should throw an AppError if an error occurs while updating the supplier", async () => {
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
    const updateData = { name: "Updated Name" };

    vi.spyOn(supplierInMemory, "updateSupplier").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      updateSupplierUseCase.execute(
        updateData,
        supplier.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar o fornecedor! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
