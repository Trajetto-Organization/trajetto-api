import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

describe("Update Vehicle Zod Validation Fields", () => {
  it("should pass validation with valid partial data", () => {
    const validData = {
      description: "Caminhão Mercedes Atualizado",
      status: "IN_ROUTE",
    };

    const parsed = updateVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should pass validation with all fields", () => {
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

    const parsed = updateVehicleSchema.parse(validData);
    expect(parsed).toBeDefined();
  });

  it("should pass validation with empty object (all fields optional)", () => {
    const validData = {};

    const parsed = updateVehicleSchema.parse(validData);
    expect(parsed).toEqual({});
  });

  // Description validations
  it("should reject description with less than 3 characters", () => {
    const invalidData = {
      description: "Ab",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should reject description with whitespace only", () => {
    const invalidData = {
      description: "   ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A descrição não pode ser vazia ou conter apenas espaços.",
    );
  });

  // License plate validations
  it("should accept valid license plate in old format", () => {
    const data = {
      license_plate: "ABC1234",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.license_plate).toBe("ABC1234");
  });

  it("should accept valid license plate in Mercosul format", () => {
    const data = {
      license_plate: "ABC1D23",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.license_plate).toBe("ABC1D23");
  });

  it("should reject license plate with invalid format", () => {
    const invalidData = {
      license_plate: "1234ABC",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A placa deve estar no formato ABC1234 ou ABC1D23.",
    );
  });

  // Fleet type validations
  it("should accept OWNED fleet type", () => {
    const data = {
      fleet_type: "OWNED",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.fleet_type).toBe("OWNED");
  });

  it("should accept THIRD_PARTY fleet type", () => {
    const data = {
      fleet_type: "THIRD_PARTY",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.fleet_type).toBe("THIRD_PARTY");
  });

  it("should reject invalid fleet type", () => {
    const invalidData = {
      fleet_type: "INVALID",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "Tipo de frota inválido. Deve ser OWNED ou THIRD_PARTY",
    );
  });

  // Current mileage validations
  it("should accept valid current mileage", () => {
    const data = {
      current_mileage: 50000,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.current_mileage).toBe(50000);
  });

  it("should reject negative current mileage", () => {
    const invalidData = {
      current_mileage: -100,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem atual deve ser um valor não negativo.",
    );
  });

  it("should reject current mileage exceeding maximum", () => {
    const invalidData = {
      current_mileage: 10000000,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem atual não pode exceder 9.999.999 km.",
    );
  });

  it("should accept null current mileage", () => {
    const data = {
      current_mileage: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.current_mileage).toBeNull();
  });

  // RENAVAM validations
  it("should accept valid RENAVAM", () => {
    const data = {
      renavam: "12345678901",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.renavam).toBe("12345678901");
  });

  it("should reject RENAVAM with less than 11 digits", () => {
    const invalidData = {
      renavam: "1234567890",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O RENAVAM deve ter exatamente 11 dígitos.",
    );
  });

  it("should reject RENAVAM with non-numeric characters", () => {
    const invalidData = {
      renavam: "1234567890A",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O RENAVAM deve conter apenas números.",
    );
  });

  // Status validations
  it("should accept ACTIVE status", () => {
    const data = {
      status: "ACTIVE",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.status).toBe("ACTIVE");
  });

  it("should accept INACTIVE status", () => {
    const data = {
      status: "INACTIVE",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.status).toBe("INACTIVE");
  });

  it("should accept BLOCKED status", () => {
    const data = {
      status: "BLOCKED",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.status).toBe("BLOCKED");
  });

  it("should accept IN_ROUTE status", () => {
    const data = {
      status: "IN_ROUTE",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.status).toBe("IN_ROUTE");
  });

  it("should reject invalid status", () => {
    const invalidData = {
      status: "INVALID_STATUS",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "Status inválido. Deve ser ACTIVE, INACTIVE, BLOCKED ou IN_ROUTE",
    );
  });

  // UUID validations
  it("should accept valid UUID for fuelTypeId", () => {
    const data = {
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.fuelTypeId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("should reject invalid UUID for fuelTypeId", () => {
    const invalidData = {
      fuelTypeId: "invalid-uuid",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "ID do tipo de combustível é inválido.",
    );
  });

  it("should accept null for vehicleTypeId", () => {
    const data = {
      vehicleTypeId: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.vehicleTypeId).toBeNull();
  });

  it("should accept null for driverId", () => {
    const data = {
      driverId: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.driverId).toBeNull();
  });

  it("should accept null for branchId", () => {
    const data = {
      branchId: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.branchId).toBeNull();
  });

  // Manufacturing and model year validations
  it("should accept model year equal to manufacturing year", () => {
    const data = {
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });

  it("should accept model year one year after manufacturing year", () => {
    const data = {
      manufacturing_year: "2023-01-01",
      model_year: "2024-01-01",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });

  it("should reject model year more than one year after manufacturing year", () => {
    const invalidData = {
      manufacturing_year: "2023-01-01",
      model_year: "2025-01-01",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O ano do modelo deve ser igual ao ano de fabricação ou no máximo um ano posterior",
    );
  });

  it("should reject invalid manufacturing year", () => {
    const invalidData = {
      manufacturing_year: "invalid-date",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "Ano de fabricação inválido.",
    );
  });

  // Maintenance interval validations
  it("should accept valid maintenance interval km", () => {
    const data = {
      maintenance_interval_km: 10000,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.maintenance_interval_km).toBe(10000);
  });

  it("should reject maintenance interval km exceeding maximum", () => {
    const invalidData = {
      maintenance_interval_km: 100001,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de revisão não pode exceder 100.000 km.",
    );
  });

  it("should accept valid maintenance interval months", () => {
    const data = {
      maintenance_interval_months: 6,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.maintenance_interval_months).toBe(6);
  });

  it("should reject maintenance interval months exceeding maximum", () => {
    const invalidData = {
      maintenance_interval_months: 61,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de manutenção não pode exceder 60 meses (5 anos).",
    );
  });

  // Km per liter validations
  it("should accept valid km per liter", () => {
    const data = {
      km_per_liter: 10,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.km_per_liter).toBe(10);
  });

  it("should reject km per liter exceeding maximum", () => {
    const invalidData = {
      km_per_liter: 51,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O consumo em km/l não pode exceder 50.",
    );
  });

  // Number of axles validations
  it("should accept valid number of axles", () => {
    const data = {
      number_of_axles: 3,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.number_of_axles).toBe(3);
  });

  it("should reject number of axles less than minimum", () => {
    const invalidData = {
      number_of_axles: 1,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O número de eixos deve ser pelo menos 2.",
    );
  });

  it("should reject number of axles exceeding maximum", () => {
    const invalidData = {
      number_of_axles: 11,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O número de eixos não pode exceder 10.",
    );
  });

  // Last maintenance mileage vs current mileage validation
  it("should reject last maintenance mileage greater than current mileage", () => {
    const invalidData = {
      current_mileage: 50000,
      last_maintenance_mileage: 60000,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem da última revisão não pode ser superior à quilometragem atual",
    );
  });

  it("should accept last maintenance mileage less than current mileage", () => {
    const data = {
      current_mileage: 50000,
      last_maintenance_mileage: 40000,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });

  // Additional properties
  it("should ignore additional properties", () => {
    const dataWithExtra = {
      description: "Caminhão Mercedes",
      extraField: "should be ignored",
    };

    const parsed = updateVehicleSchema.parse(dataWithExtra);
    expect(parsed.description).toBe("Caminhão Mercedes");
  });

  // Description - more detailed tests
  it("should reject description with more than 100 characters", () => {
    const invalidData = {
      description: "A".repeat(101),
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A descrição deve ter no máximo 100 caracteres.",
    );
  });

  it("should reject description with consecutive spaces", () => {
    const invalidData = {
      description: "Caminhão  Mercedes",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A descrição não deve conter espaços consecutivos.",
    );
  });

  it("should reject description with spaces at edges", () => {
    const invalidData = {
      description: " Caminhão Mercedes ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A descrição não pode começar ou terminar com espaço em branco.",
    );
  });

  // License plate - more detailed tests
  it("should reject license plate with less than 7 characters", () => {
    const invalidData = {
      license_plate: "ABC123",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A placa deve ter no mínimo 7 caracteres.",
    );
  });

  it("should reject license plate with whitespace only", () => {
    const invalidData = {
      license_plate: "       ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A placa não pode ser vazia ou conter apenas espaços.",
    );
  });

  it("should reject license plate with consecutive spaces", () => {
    const invalidData = {
      license_plate: "ABC  123",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A placa não deve conter espaços consecutivos.",
    );
  });

  it("should reject license plate with spaces at edges", () => {
    const invalidData = {
      license_plate: " ABC1234 ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A placa não pode começar ou terminar com espaço em branco.",
    );
  });

  // Brand - detailed tests
  it("should reject brand with less than 2 characters", () => {
    const invalidData = {
      brand: "M",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A marca deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject brand with more than 50 characters", () => {
    const invalidData = {
      brand: "A".repeat(51),
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A marca deve ter no máximo 50 caracteres.",
    );
  });

  it("should reject brand with whitespace only", () => {
    const invalidData = {
      brand: "   ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A marca não pode ser vazia ou conter apenas espaços.",
    );
  });

  it("should reject brand with consecutive spaces", () => {
    const invalidData = {
      brand: "Mercedes  Benz",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A marca não deve conter espaços consecutivos.",
    );
  });

  it("should reject brand with spaces at edges", () => {
    const invalidData = {
      brand: " Mercedes ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A marca não pode começar ou terminar com espaço em branco.",
    );
  });

  // Model - detailed tests
  it("should reject model with less than 2 characters", () => {
    const invalidData = {
      model: "A",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O modelo deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject model with more than 50 characters", () => {
    const invalidData = {
      model: "A".repeat(51),
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O modelo deve ter no máximo 50 caracteres.",
    );
  });

  it("should reject model with whitespace only", () => {
    const invalidData = {
      model: "   ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O modelo não pode ser vazio ou conter apenas espaços.",
    );
  });

  it("should reject model with consecutive spaces", () => {
    const invalidData = {
      model: "Actros  2546",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O modelo não deve conter espaços consecutivos.",
    );
  });

  it("should reject model with spaces at edges", () => {
    const invalidData = {
      model: " Actros ",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O modelo não pode começar ou terminar com espaço em branco.",
    );
  });

  // Acquisition date validations
  it("should accept valid acquisition date", () => {
    const data = {
      acquisition_date: "2023-01-15",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.acquisition_date).toBe("2023-01-15");
  });

  it("should reject invalid acquisition date", () => {
    const invalidData = {
      acquisition_date: "invalid-date",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "Data de aquisição inválida.",
    );
  });

  // Model year validations
  it("should reject invalid model year", () => {
    const invalidData = {
      model_year: "invalid-date",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "Ano do modelo inválido.",
    );
  });

  // Maintenance interval km - more tests
  it("should reject zero maintenance interval km", () => {
    const invalidData = {
      maintenance_interval_km: 0,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de revisão em km deve ser um valor positivo.",
    );
  });

  it("should reject negative maintenance interval km", () => {
    const invalidData = {
      maintenance_interval_km: -100,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de revisão em km deve ser um valor positivo.",
    );
  });

  // Maintenance interval months - more tests
  it("should reject zero maintenance interval months", () => {
    const invalidData = {
      maintenance_interval_months: 0,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de manutenção em meses deve ser um valor positivo.",
    );
  });

  it("should reject negative maintenance interval months", () => {
    const invalidData = {
      maintenance_interval_months: -6,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O intervalo de manutenção em meses deve ser um valor positivo.",
    );
  });

  // Km per liter - more tests
  it("should reject zero km per liter", () => {
    const invalidData = {
      km_per_liter: 0,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O consumo em km/l deve ser um valor positivo.",
    );
  });

  it("should reject negative km per liter", () => {
    const invalidData = {
      km_per_liter: -5,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O consumo em km/l deve ser um valor positivo.",
    );
  });

  // Number of axles - more tests
  it("should reject non-integer number of axles", () => {
    const invalidData = {
      number_of_axles: 3.5,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "O número de eixos deve ser um número inteiro.",
    );
  });

  // UUID validations
  it("should reject invalid UUID for vehicleTypeId", () => {
    const invalidData = {
      vehicleTypeId: "invalid-uuid",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "ID do tipo de veículo é inválido.",
    );
  });

  it("should reject invalid UUID for driverId", () => {
    const invalidData = {
      driverId: "invalid-uuid",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "ID do motorista é inválido.",
    );
  });

  it("should reject invalid UUID for branchId", () => {
    const invalidData = {
      branchId: "invalid-uuid",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "ID da filial é inválido.",
    );
  });

  // Last maintenance mileage validations
  it("should accept null last maintenance mileage", () => {
    const data = {
      last_maintenance_mileage: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.last_maintenance_mileage).toBeNull();
  });

  it("should reject negative last maintenance mileage", () => {
    const invalidData = {
      last_maintenance_mileage: -100,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem da última revisão deve ser um valor não negativo.",
    );
  });

  it("should reject last maintenance mileage exceeding maximum", () => {
    const invalidData = {
      last_maintenance_mileage: 10000000,
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "A quilometragem da última revisão não pode exceder 9.999.999 km.",
    );
  });

  // Fleet id and last maintenance date validations
  it("should accept null fleet_id", () => {
    const data = {
      fleet_id: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.fleet_id).toBeNull();
  });

  it("should accept string fleet_id", () => {
    const data = {
      fleet_id: "FLEET-001",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.fleet_id).toBe("FLEET-001");
  });

  it("should accept null last_maintenance_date", () => {
    const data = {
      last_maintenance_date: null,
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.last_maintenance_date).toBeNull();
  });

  it("should accept valid last_maintenance_date", () => {
    const data = {
      last_maintenance_date: "2023-01-15",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed).toBeDefined();
  });

  it("should reject invalid last_maintenance_date", () => {
    const invalidData = {
      last_maintenance_date: "invalid-date",
    };

    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateVehicleSchema.parse(invalidData)).toThrow(
      "Data da última manutenção inválida",
    );
  });

  it("should convert empty string to null for last_maintenance_date", () => {
    const data = {
      last_maintenance_date: "",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.last_maintenance_date).toBeNull();
  });

  it("should convert empty string to null for vehicleTypeId", () => {
    const data = {
      vehicleTypeId: "",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.vehicleTypeId).toBeNull();
  });

  it("should convert empty string to null for driverId", () => {
    const data = {
      driverId: "",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.driverId).toBeNull();
  });

  it("should convert empty string to null for branchId", () => {
    const data = {
      branchId: "",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.branchId).toBeNull();
  });

  it("should convert empty string to null for last_maintenance_mileage", () => {
    const data = {
      last_maintenance_mileage: "",
    };

    const parsed = updateVehicleSchema.parse(data);
    expect(parsed.last_maintenance_mileage).toBeNull();
  });
});
