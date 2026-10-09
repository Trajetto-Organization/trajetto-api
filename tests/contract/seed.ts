import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Minimal valid rows for the tables the contract suites point at. Each takes
 * a short `n` that keeps its unique columns (CNPJ, CPF, CNH, e-mail, plate)
 * distinct across a file.
 */

const digits = (n: number, length: number) => String(n).padStart(length, "0");

function businessData(
  id: string,
  n: number,
  extra: Partial<Prisma.BusinessCreateInput> = {},
) {
  return {
    id,
    corporate_reason: `Transportadora Contrato ${n}`,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: String(n),
    cnpj: `8${digits(n, 13)}`,
    cnae: "4930202",
    responsible_name: "Responsável",
    telephone: "11999990000",
    email: `empresa-${n}@contrato.test`,
    ...extra,
  } satisfies Prisma.BusinessCreateInput;
}

async function seedBusiness(
  prisma: PrismaClient,
  id: string,
  n: number,
  extra: Partial<Prisma.BusinessCreateInput> = {},
) {
  return prisma.business.create({ data: businessData(id, n, extra) });
}

async function seedBranch(
  prisma: PrismaClient,
  businessId: string,
  n: number,
  id?: string,
) {
  return prisma.branch.create({
    data: {
      ...(id && { id }),
      corporate_reason: `Filial Contrato ${n}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: String(n),
      cnpj: `7${digits(n, 13)}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999990000",
      email: `filial-${n}@contrato.test`,
      businessId,
    },
  });
}

async function seedDriver(
  prisma: PrismaClient,
  businessId: string,
  n: number,
  extra: Partial<Prisma.DriverUncheckedCreateInput> = {},
) {
  return prisma.driver.create({
    data: {
      name: `Motorista Contrato ${n}`,
      birth_date: new Date("1990-01-01T00:00:00.000Z"),
      cnh: `6${digits(n, 10)}`,
      cpf: `5${digits(n, 10)}`,
      rg: "123456789",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
      ...extra,
    },
  });
}

async function seedUser(
  prisma: PrismaClient,
  businessId: string | null,
  n: number,
  extra: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  return prisma.user.create({
    data: {
      email: `pessoa-${n}@contrato.test`,
      name: `Pessoa Contrato ${n}`,
      password: "$2a$08$hash.do.contrato.................................",
      role: "BUSINESS_USER",
      businessId,
      ...extra,
    },
  });
}

async function seedFuelType(
  prisma: PrismaClient,
  businessId: string,
  description = "Diesel S10",
) {
  return prisma.fuelType.create({ data: { description, businessId } });
}

async function seedVehicle(
  prisma: PrismaClient,
  businessId: string,
  plate: string,
  extra: Partial<Prisma.VehicleUncheckedCreateInput> = {},
) {
  const fuelTypeId =
    extra.fuelTypeId ??
    (await seedFuelType(prisma, businessId, `Diesel ${plate}`)).id;

  return prisma.vehicle.create({
    data: {
      description: `Caminhão ${plate}`,
      license_plate: plate,
      brand: "Scania",
      model: "R450",
      acquisition_date: new Date("2024-01-10T00:00:00.000Z"),
      fleet_type: "OWNED",
      current_mileage: 1000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `rnv-${plate}`,
      manufacturing_year: new Date("2023-01-01T00:00:00.000Z"),
      model_year: new Date("2024-01-01T00:00:00.000Z"),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId,
      ...extra,
      fuelTypeId,
    },
  });
}

async function seedShipper(
  prisma: PrismaClient,
  businessId: string,
  name: string,
  id?: string,
) {
  return prisma.shipper.create({
    data: { ...(id && { id }), name, businessId },
  });
}

export {
  businessData,
  seedBranch,
  seedBusiness,
  seedDriver,
  seedFuelType,
  seedShipper,
  seedUser,
  seedVehicle,
};
