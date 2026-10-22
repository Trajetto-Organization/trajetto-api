import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { BranchRepository } from "@/modules/branch/repositories/branch-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { FuelTypeRepository } from "@/modules/fuel-type/repositories/fuel-type-repository";
import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { PartRepository } from "@/modules/part/repositories/part-repository";
import { ProfileAccessRepository } from "@/modules/profile-access/repositories/profile-access-repository";
import { QuoteRepository } from "@/modules/quote/repositories/quote-repository";
import { ShipperRepository } from "@/modules/shipper/repositories/shipper-repository";
import { SupplierRepository } from "@/modules/supplier/repositories/supplier-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { VehicleTypeRepository } from "@/modules/vehicle-type/repositories/vehicle-type-repository";

/**
 * Every "does this already exist?" lookup, probed with a wildcard.
 *
 * `{ equals: value, mode: "insensitive" }` is `ILIKE $1` on Postgres, and the
 * value is the pattern. Unescaped, "1%" matched any CNH starting with 1 — in
 * any tenant — and the duplicate error answered yes: a stranger's CNH could be
 * read back one character per request. "j_hn@..." matched "john@..." at the
 * login and the password reset. Inside one tenant, a supplier named "%" was
 * "already registered" whatever the list held.
 *
 * Each lookup must still find its row exactly (and ignoring case, which is why
 * it is ILIKE at all), including a legitimate `_` in the value, and must find
 * nothing for a probe that only matches as a pattern.
 */
const prisma = new PrismaClient();

const A = "018fe070-0000-7000-8000-00000000000a";
const B = "018fe070-0000-7000-8000-00000000000b";

const drivers = new DriverRepository(prisma);
const users = new UserRepository(prisma);
const vehicles = new VehicleRepository(prisma);
const branches = new BranchRepository(prisma);
const businesses = new BusinessRepository(prisma);
const suppliers = new SupplierRepository(prisma);
const parts = new PartRepository(prisma);
const fuelTypes = new FuelTypeRepository(prisma);
const vehicleTypes = new VehicleTypeRepository(prisma);
const profiles = new ProfileAccessRepository(prisma);
const occurrenceTypes = new OccurrenceTypeRepository(prisma);
const shippers = new ShipperRepository(prisma);
const quotes = new QuoteRepository(prisma);

async function company(id: string, suffix: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora Curinga ${suffix}`,
      erp_code: `ERP_${suffix}1`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `contato_${suffix.toLowerCase()}-${id.slice(-4)}@exemplo.com.br`,
    },
  });
}

let fuelTypeId = "";

beforeAll(async () => {
  await company(A, "A");
  await company(B, "B");

  await prisma.user.createMany({
    data: [
      {
        name: "John",
        email: "john.probe@exemplo.com.br",
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: A,
      },
      {
        name: "Mary Ann",
        email: "mary_ann@exemplo.com.br",
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: A,
      },
    ],
  });

  await prisma.driver.create({
    data: {
      name: "Motorista do A",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "123.456.789-01",
      rg: "12.345.678-9",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: A,
    },
  });

  fuelTypeId = (
    await prisma.fuelType.create({
      data: { description: "Diesel_S10", businessId: A },
    })
  ).id;

  await prisma.vehicle.create({
    data: {
      description: "Caminhão",
      license_plate: "ABC1D23",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "98765432109",
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: A,
      fuelTypeId,
    },
  });

  await prisma.branch.create({
    data: {
      corporate_reason: "Filial_Curinga Ltda",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId: A,
    },
  });

  await prisma.supplier.create({
    data: {
      name: "Fornecedor_Curinga",
      cnpj: String(63000000000000 + Math.floor(Math.random() * 9000000)),
      email: "compras_a@fornecedor.com.br",
      businessId: A,
    },
  });

  await prisma.part.create({
    data: { description: "Filtro_oleo", unit_price: 10, businessId: A },
  });

  await prisma.vehicleType.create({
    data: { description: "Truck_3eixos", number_of_axles: 3, businessId: A },
  });

  await prisma.profileAccess.create({
    data: { name: "Gestao_frota", businessId: A },
  });

  await prisma.occurrenceType.create({
    data: { name: "Cliente_ausente", businessId: A },
  });

  await prisma.shipper.create({
    data: { name: "Embarcador_Curinga", businessId: A },
  });

  await prisma.quote.create({
    data: {
      name: "Interessado",
      company: "Empresa",
      email: "cotacao_a@exemplo.com.br",
      telephone: "11999999999",
      fleet_size: "10",
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a wildcard typed into a duplicate check", () => {
  it("does not read another tenant's CNH back", async () => {
    // The platform-wide ILIKE lookup is gone: the CNH is unique per company
    // (decision 8.1) and is looked up by equality inside it.
    expect(await drivers.findDriverByCnh("1%", A)).toBeNull();
    expect(await drivers.findDriverByCnh("1234567890_", A)).toBeNull();

    expect(await drivers.findDriverByCnh("12345678901", A)).not.toBeNull();
  });

  it("does not stand in for a letter of an e-mail at the login", async () => {
    expect(await users.findUserByEmail("j_hn.probe@exemplo.com.br")).toBeNull();
    expect(await users.findUserByEmail("%@exemplo.com.br")).toBeNull();
    expect(
      await users.findUserByEmailAndBusinessId("j_hn.probe@exemplo.com.br", A),
    ).toBeNull();

    // Case still does not matter, and a real underscore still matches.
    expect(
      await users.findUserByEmail("JOHN.PROBE@exemplo.com.br"),
    ).not.toBeNull();
    expect(
      await users.findUserByEmail("mary_ann@exemplo.com.br"),
    ).not.toBeNull();
    expect(
      await users.findUserByEmailAndBusinessId("Mary_Ann@exemplo.com.br", A),
    ).not.toBeNull();
  });

  it("does not match plates, RENAVAMs, branches or companies by pattern", async () => {
    expect(await vehicles.findVehicleByLicensePlate("ABC%", A)).toBeNull();
    expect(await vehicles.findVehicleByRenavam("9876543210_", A)).toBeNull();
    expect(
      await vehicles.findVehicleByLicensePlate("abc1d23", A),
    ).not.toBeNull();

    expect(await branches.findBranchByCorporateReason(A, "Filial%")).toBeNull();
    expect(
      await branches.findBranchByCorporateReason(A, "filial_curinga ltda"),
    ).not.toBeNull();

    expect(
      await businesses.findBusinessByCorporateReason(
        "Transportadora Curinga _",
      ),
    ).toBeNull();
    expect(await businesses.findBusinessByErpcode("ERP%")).toBeNull();
    expect(await businesses.findBusinessByEmail("contato%")).toBeNull();
    expect(await businesses.findBusinessByErpcode("erp_a1")).not.toBeNull();
  });

  it("does not match a tenant's catalogue entries by pattern", async () => {
    expect(
      await suppliers.findSupplierByNameAndBusinessId("Fornecedor%", A),
    ).toBeNull();
    expect(await suppliers.findSupplierByNameAndBusinessId("%", A)).toBeNull();
    expect(
      await suppliers.findSupplierByEmailAndBusinessId("compras%", A),
    ).toBeNull();
    expect(
      await suppliers.findSupplierByEmailAndBusinessId(
        "COMPRAS_A@fornecedor.com.br",
        A,
      ),
    ).not.toBeNull();
    expect(
      await suppliers.findSupplierByNameAndBusinessId("fornecedor_curinga", A),
    ).not.toBeNull();

    expect(await parts.findPartByDescription("Filtro%", A)).toBeNull();
    expect(await parts.findPartByDescription("FILTRO_OLEO", A)).not.toBeNull();

    expect(await fuelTypes.findFuelTypeByDescription("Diesel%", A)).toBeNull();
    expect(
      await fuelTypes.findFuelTypeByDescription("diesel_s10", A),
    ).not.toBeNull();

    expect(
      await vehicleTypes.findVehicleTypeByDescription("Truck%", A),
    ).toBeNull();
    expect(
      await vehicleTypes.findVehicleTypeByDescription("truck_3eixos", A),
    ).not.toBeNull();

    expect(
      await profiles.findProfileAccessByNameAndBusiness({
        name: "G%",
        businessId: A,
      }),
    ).toBeNull();
    expect(
      await profiles.findProfileAccessByNameAndBusiness({
        name: "gestao_frota",
        businessId: A,
      }),
    ).not.toBeNull();

    expect(
      await occurrenceTypes.findOccurrenceTypeByName(A, "Cliente%"),
    ).toBeNull();
    expect(
      await occurrenceTypes.findOccurrenceTypeByName(A, "cliente_ausente"),
    ).not.toBeNull();

    expect(await shippers.findShipperByName(A, "Embarcador%")).toBeNull();
    expect(
      await shippers.findShipperByName(A, "embarcador_curinga"),
    ).not.toBeNull();
  });

  it("does not collapse two quote requests by pattern", async () => {
    expect(await quotes.findQuoteByEmail("%@exemplo.com.br")).toBeNull();
    expect(
      await quotes.findQuoteByEmail("COTACAO_A@exemplo.com.br"),
    ).not.toBeNull();
  });
});
