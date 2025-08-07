import http from "http";
import request from "supertest";

import prisma from "@/../infra/database";
import { hash } from "bcrypt";

import { UserRole } from "@/modules/user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";

interface CreateAuthenticateUser {
  userId: string;
  token: string;
  refresh_token: string;
  profileAccessId: string;
  businessId: string;
  permissionId: string;
}

interface CreateAuthenticateUserProps {
  app: http.Server;
  userRole: UserRole;
  canWrite?: boolean;
  permissionKey?: PermissionKey;
  email?: string;
}

async function createAuthenticateUser({
  app,
  userRole = "BUSINESS_USER",
  canWrite = false,
  permissionKey,
  email = "test@example.com",
}: CreateAuthenticateUserProps): Promise<CreateAuthenticateUser> {
  const user = await prisma.user.create({
    data: {
      email: email,
      name: "Test User",
      password: await hash("1234567", 6),
      role: userRole,
    },
  });

  let profileAccessId: string = "";
  let businessId: string = "";

  let permissionId: string = "";

  if (userRole === "BUSINESS_USER") {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: "newbusiness@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP100",
    };

    const createdBusiness = await prisma.business.create({
      data: businessData,
    });

    const createdProfileAccess = await prisma.profileAccess.create({
      data: {
        name: "Management",
        businessId: createdBusiness.id,
      },
    });

    const createdPermission = await prisma.permission.create({
      data: {
        action: "Permission",
        businessId: createdBusiness.id,
        profileAccessId: createdProfileAccess.id,
        canRead: true,
        canWrite,
        permissionKey,
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        profileAccessId: createdProfileAccess.id,
        businessId: createdBusiness.id,
      },
    });

    profileAccessId = createdProfileAccess.id;
    businessId = createdBusiness.id;

    permissionId = createdPermission.id;
  }

  const authResponse = await request(app).post("/user/session").send({
    email: "test@example.com",
    password: "1234567",
  });

  const { token, refresh_token } = authResponse.body;

  return {
    token,
    refresh_token,
    profileAccessId,
    businessId,
    permissionId,
    userId: user.id,
  };
}

export { createAuthenticateUser };
