import { describe, it, expect, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { CreateUserUseCase } from "@/modules/user/usecases/create-user/create-user-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ProfileAccessNotFoundError } from "@/modules/user/usecases/errors/profile-access-not-found-error";
import { UserProfileNotMatchBusinessError } from "@/modules/user/usecases/errors/user-profile-not-match-business-error";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { UserAlreadyExistsError } from "@/modules/user/usecases/errors/user-already-exists.error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryMailProvider } from "@/shared/providers/mail-provider/in-memory/in-memory-mail-provider";

import { AppError } from "@/shared/errors/AppError";

describe("Create User UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let profileAccessInMemory: InMemoryProfileAccessRepository;
  let mailProvider: InMemoryMailProvider;

  let createUserUseCase: CreateUserUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    profileAccessInMemory = new InMemoryProfileAccessRepository();
    mailProvider = new InMemoryMailProvider();

    createUserUseCase = new CreateUserUseCase(
      userInMemory,
      businessInMemory,
      profileAccessInMemory,
      mailProvider,
    );
  });

  // Cenário de sucesso já testado:
  it("should be able to create a user", async () => {
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
    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Profile Access",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: business.id as string,
      profileAccessId: profileAccess.id,
    });

    const newUser = await createUserUseCase.execute(
      {
        email: "newuser@example.com",
        password: "newuserpass",
        name: "New User",
        role: "BUSINESS_USER",
        businessId: business.id as string,
        profileAccessId: profileAccess.id,
      },
      adminUser.id,
    );

    expect(newUser).toHaveProperty("id");

    expect(newUser.email).toBe("newuser@example.com");
    expect(newUser.role).toBe("BUSINESS_USER");
  });

  it("should throw ResourceNotFoundError if admin user is not found", async () => {
    const business = await businessInMemory.createBusiness({
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

    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Profile Access",
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "newuser@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_USER",
          businessId: business.id as string,
          profileAccessId: profileAccess.id,
        },
        "non-existent-admin-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  // Cenário 2: Nível de acesso do admin não permite criar o usuário
  it("should throw AppError if admin user's role does not allow creating target role", async () => {
    const business = await businessInMemory.createBusiness({
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

    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Profile Access",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: profileAccess.id,
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "newuser@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_ADMIN",
          businessId: business.id as string,
          profileAccessId: profileAccess.id,
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should throw ProfileAccessNotFoundError if profile access is not found", async () => {
    const business = await businessInMemory.createBusiness({
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

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: business.id as string,
      profileAccessId: "existing-profile",
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "newuser@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_USER",
          businessId: business.id as string,
          profileAccessId: "non-existent-profile",
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessNotFoundError);
  });

  it("should throw UserProfileNotMatchBusinessError if profile access business does not match", async () => {
    const business = await businessInMemory.createBusiness({
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

    const otherBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Other Business",
      cnpj: "98765432000100",
      fantasy_name: "Other Fantasia",
      cep: "87654321",
      city: "Other City",
      uf: "OT",
      street: "Other Street",
      address_number: "321",
      telephone: "2222222222",
      email: "other@example.com",
      cnae: "7654321",
      responsible_name: "Other Responsible",
      erp_code: "ERP321",
    });

    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: otherBusiness.id as string,
      name: "Profile Access",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: business.id as string,
      profileAccessId: profileAccess.id,
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "newuser@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_USER",
          businessId: business.id as string,
          profileAccessId: profileAccess.id,
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(UserProfileNotMatchBusinessError);
  });

  it("should throw BusinessNotFoundError if business is not found", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "non-existent-business",
      profileAccessId: "profile-1",
    });

    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: "non-existent-business",
      name: "Profile Access",
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "newuser@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_USER",
          businessId: "non-existent-business",
          profileAccessId: profileAccess.id,
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw UserAlreadyExistsError if a user with the same email already exists", async () => {
    const business = await businessInMemory.createBusiness({
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

    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Profile Access",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: business.id as string,
      profileAccessId: profileAccess.id,
    });

    await userInMemory.createUser({
      email: "duplicate@example.com",
      password: await hash("somepass", 6),
      name: "Existing User",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: profileAccess.id,
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "duplicate@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_USER",
          businessId: business.id as string,
          profileAccessId: profileAccess.id,
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  it("should throw an AppError if an error occurs while creating the user", async () => {
    const business = await businessInMemory.createBusiness({
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

    const profileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Profile Access",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: business.id as string,
      profileAccessId: profileAccess.id,
    });

    vi.spyOn(userInMemory, "createUser").mockImplementationOnce(async () => {
      throw new Error("DB failure");
    });

    await expect(
      createUserUseCase.execute(
        {
          email: "newuser@example.com",
          password: "newuserpass",
          name: "New User",
          role: "BUSINESS_USER",
          businessId: business.id as string,
          profileAccessId: profileAccess.id,
        },
        adminUser.id,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar criar o usuário! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
