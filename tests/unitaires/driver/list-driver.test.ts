import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ListDriverUseCase } from "@/modules/driver/usecases/list-driver/list-driver-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";

describe("List Driver UseCase", () => {
  let driverInMemory: InMemoryDriverRepository;
  let userInMemory: InMemoryUserRepository;

  let listDriver: ListDriverUseCase;

  beforeEach(() => {
    driverInMemory = new InMemoryDriverRepository();
    userInMemory = new InMemoryUserRepository();

    listDriver = new ListDriverUseCase(userInMemory, driverInMemory);
  });

  it("should be able to list drivers", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    // Create multiple drivers for the same business
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
      businessId: businessId,
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
      businessId: businessId,
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

    const result = await listDriver.execute(createdUser.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].name).toBe("First Driver");
    expect(result.data[1].name).toBe("Second Driver");

    // Verify both drivers belong to the correct business
    result.data.forEach((driver) => {
      expect(driver.businessId).toBe(businessId);
    });
  });

  it("should be able to list drivers with pagination", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
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
        businessId: businessId,
      });
    }

    // Test first page
    const firstPage = await listDriver.execute(createdUser.id, 1, 3);

    expect(firstPage.data).toHaveLength(3);
    expect(firstPage.total).toBe(5);

    // Test second page
    const secondPage = await listDriver.execute(createdUser.id, 2, 3);

    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.total).toBe(5);
  });

  it("should be able to search drivers by name", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await driverInMemory.createDriver({
      name: "João Silva",
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
      businessId: businessId,
    });

    await driverInMemory.createDriver({
      name: "Maria Santos",
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
      businessId: businessId,
    });

    const searchResult = await listDriver.execute(
      createdUser.id,
      1,
      10,
      "joão",
    );

    expect(searchResult.data).toHaveLength(1);
    expect(searchResult.total).toBe(1);

    expect(searchResult.data[0].name).toBe("João Silva");
  });

  it("should be able to search drivers by CPF", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await driverInMemory.createDriver({
      name: "João Silva",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "12345678901",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: businessId,
    });

    await driverInMemory.createDriver({
      name: "Maria Santos",
      birth_date: new Date("1985-05-15"),
      cnh: "22222222222",
      cpf: "98765432100",
      rg: "222222222",
      cep: "87654321",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "789",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: businessId,
    });

    const searchResult = await listDriver.execute(
      createdUser.id,
      1,
      10,
      "123456",
    );

    expect(searchResult.data).toHaveLength(1);
    expect(searchResult.total).toBe(1);

    expect(searchResult.data[0].cpf).toBe("12345678901");
  });

  it("should be able to search drivers by CNH", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await driverInMemory.createDriver({
      name: "João Silva",
      birth_date: new Date("1990-01-01"),
      cnh: "98765432100",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: businessId,
    });

    await driverInMemory.createDriver({
      name: "Maria Santos",
      birth_date: new Date("1985-05-15"),
      cnh: "12345678901",
      cpf: "22222222222",
      rg: "222222222",
      cep: "87654321",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "789",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: businessId,
    });

    const searchResult = await listDriver.execute(
      createdUser.id,
      1,
      10,
      "987654",
    );

    expect(searchResult.data).toHaveLength(1);
    expect(searchResult.total).toBe(1);

    expect(searchResult.data[0].cnh).toBe("98765432100");
  });

  it("should be able to search drivers by RG", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await driverInMemory.createDriver({
      name: "João Silva",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "987654321",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: businessId,
    });

    await driverInMemory.createDriver({
      name: "Maria Santos",
      birth_date: new Date("1985-05-15"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "123456789",
      cep: "87654321",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "789",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: businessId,
    });

    const searchResult = await listDriver.execute(
      createdUser.id,
      1,
      10,
      "987654",
    );

    expect(searchResult.data).toHaveLength(1);
    expect(searchResult.total).toBe(1);

    expect(searchResult.data[0].rg).toBe("987654321");
  });

  it("should return empty list when no drivers match search", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await driverInMemory.createDriver({
      name: "João Silva",
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
      businessId: businessId,
    });

    const searchResult = await listDriver.execute(
      createdUser.id,
      1,
      10,
      "nonexistent",
    );

    expect(searchResult.data).toHaveLength(0);
    expect(searchResult.total).toBe(0);
  });

  it("should return empty list when user has no drivers", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const result = await listDriver.execute(createdUser.id, 1, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listDriver.execute("non-existing-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if list operation fails", async () => {
    const businessId = "business-id-123";

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: businessId,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    vi.spyOn(driverInMemory, "listDrivers").mockImplementationOnce(async () => {
      throw new Error("Simulated list failure");
    });

    await expect(
      listDriver.execute(createdUser.id, 1, 10),
    ).rejects.toBeInstanceOf(AppError);
  });
});
