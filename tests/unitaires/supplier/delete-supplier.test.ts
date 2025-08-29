import { describe, it, expect, beforeEach, vi } from "vitest";

import { DeleteSupplierUseCase } from "@/modules/supplier/usecases/delete-supplier/delete-supplier-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Delete Supplier UseCase", () => {
  let supplierInMemory: InMemorySupplierRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let notificationService: NotificationService;

  let deleteSupplierUseCase: DeleteSupplierUseCase;

  beforeEach(() => {
    supplierInMemory = new InMemorySupplierRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteSupplierUseCase = new DeleteSupplierUseCase(
      userInMemory,
      businessInMemory,
      supplierInMemory,
      notificationService,
    );
  });

  it("should be able to delete a supplier", async () => {
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
      name: "Fornecedor Para Deletar",
      cnpj: "98765432000199",
      email: "supplier@example.com",
      businessId: business.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const deletedSupplier = await deleteSupplierUseCase.execute(
      supplier.id,
      business.id as string,
      user.id,
    );

    expect(deletedSupplier.id).toBe(supplier.id);
    expect(deletedSupplier.name).toBe("Fornecedor Para Deletar");

    expect(deletedSupplier.cnpj).toBe("98765432000199");
    expect(deletedSupplier.email).toBe("supplier@example.com");

    const supplierExists = await supplierInMemory.findSupplierById(supplier.id);
    expect(supplierExists).toBeNull();
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      deleteSupplierUseCase.execute(
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

    await expect(
      deleteSupplierUseCase.execute(
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

    await expect(
      deleteSupplierUseCase.execute(
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

    await expect(
      deleteSupplierUseCase.execute(
        supplier.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(SupplierNotBelongBusinessError);
  });

  it("should delete supplier and verify it's actually removed from repository", async () => {
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
      cnpj: "22222222000222",
      businessId: business.id as string,
    };

    const supplier1 = await supplierInMemory.createSupplier(supplier1Data);
    const supplier2 = await supplierInMemory.createSupplier(supplier2Data);

    expect(supplierInMemory.suppliers.length).toBe(2);

    await deleteSupplierUseCase.execute(
      supplier1.id,
      business.id as string,
      user.id,
    );

    expect(supplierInMemory.suppliers.length).toBe(1);
    expect(supplierInMemory.suppliers[0].id).toBe(supplier2.id);

    const deletedSupplierCheck = await supplierInMemory.findSupplierById(
      supplier1.id,
    );
    expect(deletedSupplierCheck).toBeNull();

    const remainingSupplierCheck = await supplierInMemory.findSupplierById(
      supplier2.id,
    );
    expect(remainingSupplierCheck).not.toBeNull();
    expect(remainingSupplierCheck?.name).toBe("Fornecedor 2");
  });

  it("should throw an AppError if an error occurs while deleting the supplier", async () => {
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

    vi.spyOn(supplierInMemory, "deleteSupplier").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      deleteSupplierUseCase.execute(
        supplier.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar excluir o fornecedor! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when deleting supplier", async () => {
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
      name: "Fornecedor Para Notificação",
      cnpj: "98765432000199",
      businessId: business.id as string,
    };

    const supplier = await supplierInMemory.createSupplier(supplierData);

    const deletedSupplier = await deleteSupplierUseCase.execute(
      supplier.id,
      business.id as string,
      user.id,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Fornecedor",
      action: "delete",
      entityId: deletedSupplier.id,
      description: `Fornecedor excluído: ${deletedSupplier.name} | CNPJ: ${deletedSupplier.cnpj} | ID: ${deletedSupplier.id}`,
      status: "Deletado",
      performedBy: user.id,
      businessId: business.id,
    });
  });
});
