import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { ListDriverBusinessUseCase } from "@/modules/driver/usecases/list-driver-business/list-driver-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { AppError } from "@/shared/errors/AppError";

describe("List Driver Business UseCase", () => {
  let driverInMemory: InMemoryDriverRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listDriverBusiness: ListDriverBusinessUseCase;

  beforeEach(() => {
    driverInMemory = new InMemoryDriverRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listDriverBusiness = new ListDriverBusinessUseCase(
      userInMemory,
      driverInMemory,
      businessInMemory,
    );
  });

  it("should be able to list drivers by business", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    // Create multiple drivers for the business
    await driverInMemory.createDriver({
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City 1",
      uf: "DC",
      street: "Driver Street 1",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    await driverInMemory.createDriver({
      name: "Second Driver",
      birth_date: new Date("1985-05-15"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "222222222",
      cep: "87654321",
      city: "Driver City 2",
      uf: "DC",
      street: "Driver Street 2",
      address_number: "789",
      status: "INACTIVE",
      contract_type: "THIRD_PARTY",
      businessId: createdBusiness.id as string,
    });

    // Create driver for different business (should not appear in results)
    await driverInMemory.createDriver({
      name: "Other Business Driver",
      birth_date: new Date("1992-12-25"),
      cnh: "33333333333",
      cpf: "33333333333",
      rg: "333333333",
      cep: "11111111",
      city: "Other City",
      uf: "OC",
      street: "Other Street",
      address_number: "123",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: "other-business-id",
    });

    const result = await listDriverBusiness.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].name).toBe("First Driver");
    expect(result.data[1].name).toBe("Second Driver");

    // Verify both drivers belong to the correct business
    result.data.forEach((driver) => {
      expect(driver.businessId).toBe(createdBusiness.id);
    });
  });

  it("should be able to list drivers with pagination", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    // Create 5 drivers
    for (let i = 1; i <= 5; i++) {
      await driverInMemory.createDriver({
        name: `Driver ${i}`,
        birth_date: new Date("1990-01-01"),
        cnh: `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
        cpf: `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
        rg: `${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
        cep: "12345678",
        city: `Driver City ${i}`,
        uf: "DC",
        street: `Driver Street ${i}`,
        address_number: "456",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: createdBusiness.id as string,
      });
    }

    // Test first page
    const firstPage = await listDriverBusiness.execute(
      createdUser.id,
      1,
      3,
      createdBusiness.id as string,
    );

    expect(firstPage.data).toHaveLength(3);
    expect(firstPage.total).toBe(5);

    // Test second page
    const secondPage = await listDriverBusiness.execute(
      createdUser.id,
      2,
      3,
      createdBusiness.id as string,
    );

    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.total).toBe(5);
  });

  it("should return empty list when business has no drivers", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const result = await listDriverBusiness.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should list drivers from specific business only", async () => {
    const firstBusiness = await businessInMemory.createBusiness({
      corporate_reason: "First Business",
      cnpj: "12345678000100",
      fantasy_name: "First Fantasia",
      cep: "12345678",
      city: "First City",
      uf: "FC",
      street: "First Street",
      address_number: "123",
      telephone: "1111111111",
      email: "first@example.com",
      cnae: "1234567",
      responsible_name: "First Responsible",
      erp_code: "FIRST123",
    });

    const secondBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Second Business",
      cnpj: "98765432000100",
      fantasy_name: "Second Fantasia",
      cep: "87654321",
      city: "Second City",
      uf: "SC",
      street: "Second Street",
      address_number: "789",
      telephone: "9999999999",
      email: "second@example.com",
      cnae: "7654321",
      responsible_name: "Second Responsible",
      erp_code: "SECOND456",
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: firstBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    // Create drivers for first business
    await driverInMemory.createDriver({
      name: "First Business Driver 1",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: firstBusiness.id as string,
    });

    await driverInMemory.createDriver({
      name: "First Business Driver 2",
      birth_date: new Date("1985-05-15"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "222222222",
      cep: "87654321",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "789",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: firstBusiness.id as string,
    });

    // Create drivers for second business
    await driverInMemory.createDriver({
      name: "Second Business Driver 1",
      birth_date: new Date("1992-12-25"),
      cnh: "33333333333",
      cpf: "33333333333",
      rg: "333333333",
      cep: "11111111",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "123",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: secondBusiness.id as string,
    });

    // List drivers from first business
    const firstBusinessResult = await listDriverBusiness.execute(
      createdUser.id,
      1,
      10,
      firstBusiness.id as string,
    );

    expect(firstBusinessResult.data).toHaveLength(2);
    expect(firstBusinessResult.total).toBe(2);

    firstBusinessResult.data.forEach((driver) => {
      expect(driver.businessId).toBe(firstBusiness.id);
      expect(driver.name).toContain("First Business");
    });

    // List drivers from second business
    const secondBusinessResult = await listDriverBusiness.execute(
      createdUser.id,
      1,
      10,
      secondBusiness.id as string,
    );

    expect(secondBusinessResult.data).toHaveLength(1);
    expect(secondBusinessResult.total).toBe(1);

    expect(secondBusinessResult.data[0].businessId).toBe(secondBusiness.id);
    expect(secondBusinessResult.data[0].name).toContain("Second Business");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    await expect(
      listDriverBusiness.execute(
        "non-existing-user-id",
        1,
        10,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(
      listDriverBusiness.execute(
        createdUser.id,
        1,
        10,
        "non-existing-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw AppError if list operation fails", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    vi.spyOn(driverInMemory, "listDriverBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated list failure");
      },
    );

    await expect(
      listDriverBusiness.execute(
        createdUser.id,
        1,
        10,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
