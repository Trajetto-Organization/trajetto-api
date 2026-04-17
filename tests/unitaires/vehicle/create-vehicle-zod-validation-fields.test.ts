import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";

describe("Create Vehicle Zod Validation Fields", () => {
  it("should pass validation with valid data", () => {
    const validData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept optional fields as null", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      fleet_id: null,
      last_maintenance_date: null,
      current_mileage: 50000,
      last_maintenance_mileage: null,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      vehicleTypeId: null,
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
      driverId: null,
      branchId: null,
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.fleet_id).toBeNull();

    expect(parsed.last_maintenance_date).toBeNull();
    expect(parsed.last_maintenance_mileage).toBeNull();

    expect(parsed.vehicleTypeId).toBeNull();
    expect(parsed.driverId).toBeNull();

    expect(parsed.branchId).toBeNull();
  });

  // Description validations
  it("should reject description with less than 3 characters", () => {
    const invalidData = {
      description: "Ab",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should reject description with more than 100 characters", () => {
    const invalidData = {
      description: "A".repeat(101),
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A descrição deve ter no máximo 100 caracteres.",
    );
  });

  it("should reject description with whitespace only", () => {
    const invalidData = {
      description: "   ",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A descrição não pode ser vazia ou conter apenas espaços.",
    );
  });

  it("should reject description with consecutive spaces", () => {
    const invalidData = {
      description: "Caminhão  Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A descrição não deve conter espaços consecutivos.",
    );
  });

  it("should reject description with spaces at edges", () => {
    const invalidData = {
      description: " Caminhão Mercedes ",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A descrição não pode começar ou terminar com espaço em branco.",
    );
  });

  // License plate validations
  it("should reject license plate with less than 7 characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC123",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A placa deve ter no mínimo 7 caracteres.",
    );
  });

  it("should reject license plate with more than 8 characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC12345",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A placa deve estar no formato ABC1234 ou ABC1D23.",
    );
  });

  it("should accept valid license plate in old format (ABC1234)", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.license_plate).toBe("ABC1234");
  });

  it("should accept valid license plate in Mercosul format (ABC1D23)", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1D23",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.license_plate).toBe("ABC1D23");
  });

  it("should reject license plate with invalid format", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "1234ABC",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A placa deve estar no formato ABC1234 ou ABC1D23.",
    );
  });

  // Brand validations
  it("should reject brand with less than 2 characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "M",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A marca deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject brand with more than 50 characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "A".repeat(51),
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A marca deve ter no máximo 50 caracteres.",
    );
  });

  // Model validations
  it("should reject model with less than 2 characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "A",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O modelo deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject model with more than 50 characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "A".repeat(51),
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O modelo deve ter no máximo 50 caracteres.",
    );
  });

  // Acquisition date validations
  it("should reject invalid acquisition date", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "invalid-date",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "Data de aquisição inválida.",
    );
  });

  // Fleet type validations
  it("should accept OWNED fleet type", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.fleet_type).toBe("OWNED");
  });

  it("should accept THIRD_PARTY fleet type", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "THIRD_PARTY",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.fleet_type).toBe("THIRD_PARTY");
  });

  it("should reject invalid fleet type", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "INVALID",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "Tipo de frota inválido. Deve ser OWNED ou THIRD_PARTY",
    );
  });

  // Current mileage validations
  it("should reject negative current mileage", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: -100,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem atual deve ser um valor não negativo.",
    );
  });

  it("should reject current mileage exceeding maximum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 10000000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem atual não pode exceder 9.999.999 km.",
    );
  });

  // Maintenance interval km validations
  it("should reject maintenance interval km less than minimum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 0,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de revisão em km deve ser maior que zero.",
    );
  });

  it("should reject maintenance interval km exceeding maximum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 100001,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de revisão não pode exceder 100.000 km.",
    );
  });

  // Maintenance interval months validations
  it("should reject maintenance interval months less than minimum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 0,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de manutenção deve ser no mínimo de 1 mês.",
    );
  });

  it("should reject maintenance interval months exceeding maximum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 61,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de manutenção não pode exceder 60 meses (5 anos).",
    );
  });

  // RENAVAM validations
  it("should reject RENAVAM with less than 11 digits", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "1234567890",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O RENAVAM deve ter exatamente 11 dígitos.",
    );
  });

  it("should reject RENAVAM with non-numeric characters", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "1234567890A",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O RENAVAM deve conter apenas números.",
    );
  });

  // Manufacturing year and model year validations
  it("should reject invalid manufacturing year", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "invalid-year",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "Ano de fabricação inválido.",
    );
  });

  it("should reject invalid model year", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "invalid-year",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "Ano do modelo inválido.",
    );
  });

  it("should reject model year more than one year after manufacturing year", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2025-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O ano do modelo deve ser igual ao ano de fabricação ou no máximo um ano posterior",
    );
  });

  it("should accept model year equal to manufacturing year", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });

  it("should accept model year one year after manufacturing year", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2024-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });

  // Km per liter validations
  it("should reject km per liter less than minimum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 0,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O consumo em km/l deve ser no mínimo 1.",
    );
  });

  it("should reject km per liter exceeding maximum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 51,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O consumo em km/l não pode exceder 50.",
    );
  });

  // Number of axles validations
  it("should reject number of axles less than minimum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 0,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should reject number of axles exceeding maximum", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 11,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "O número de eixos não pode exceder 10.",
    );
  });

  // Status validations
  it("should accept valid status ACTIVE", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.status).toBe("ACTIVE");
  });

  it("should accept valid status INACTIVE", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "INACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.status).toBe("INACTIVE");
  });

  it("should accept valid status BLOCKED", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "BLOCKED",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.status).toBe("BLOCKED");
  });

  it("should accept valid status IN_ROUTE", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "IN_ROUTE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed.status).toBe("IN_ROUTE");
  });

  it("should reject invalid status", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "INVALID_STATUS",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "Status inválido. Deve ser ACTIVE, INACTIVE, BLOCKED ou IN_ROUTE",
    );
  });

  // UUID validations
  it("should reject invalid UUID for fuelTypeId", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "invalid-uuid",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "ID do tipo de combustível é inválido.",
    );
  });

  it("should reject invalid UUID for vehicleTypeId", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleTypeId: "invalid-uuid",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "ID do tipo de veículo é inválido.",
    );
  });

  it("should reject invalid UUID for driverId", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
      driverId: "invalid-uuid",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "ID do motorista é inválido.",
    );
  });

  it("should reject invalid UUID for branchId", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "invalid-uuid",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "ID da filial é inválido.",
    );
  });

  // Last maintenance mileage validation
  it("should reject last maintenance mileage greater than current mileage", () => {
    const invalidData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      last_maintenance_mileage: 60000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => createVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem da última revisão não pode ser superior à quilometragem atual",
    );
  });

  it("should accept last maintenance mileage less than current mileage", () => {
    const data = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED",
      current_mileage: 50000,
      last_maintenance_mileage: 40000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE",
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });
});
