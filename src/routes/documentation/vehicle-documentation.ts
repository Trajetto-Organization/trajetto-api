import { z } from "zod";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";
import {
  exportVehicleSchema,
  listVehicleSchema,
} from "@/schemas/list-vehicle-schema";

import { getVehicleSchema } from "@/schemas/get-vehicle-schema";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

import { errorResponse } from "./common-responses";

const vehicleBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  vehicleId: z.string().uuid("O ID do veículo é obrigatório!"),
});

const vehicleSchemas = {
  createVehicle: createVehicleSchema,
  updateVehicle: updateVehicleSchema,
  listVehicle: listVehicleSchema,
  businessIdParam: updateDeleteBusinessSchema,
  vehicleBusinessParams: vehicleBusinessParams,
  getVehicle: getVehicleSchema,
  exportVehicleQuery: exportVehicleSchema,
  searchVehicleCursor: cursorPaginationByBusinessSchema,
};

const dateLike = z.union([z.string(), z.date()]);

const statusEnum = z
  .enum(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"])
  .describe("IN_ROUTE é escrito pela rota; as pessoas escolhem entre os outros três.");

/** One line of GET /vehicle/list-vehicle. */
const vehicleListItem = z.object({
  id: z.string(),
  description: z.string(),
  license_plate: z.string().describe("Sempre em maiúsculas."),
  brand: z.string(),
  model: z.string(),
  acquisition_date: dateLike,
  fleet_type: z.enum(["OWNED", "THIRD_PARTY"]),
  fleet_id: z.string().nullable(),
  last_maintenance_date: dateLike.nullable(),
  current_mileage: z.number(),
  last_maintenance_mileage: z.number().nullable(),
  maintenance_interval_km: z.number(),
  maintenance_interval_months: z.number().int(),
  renavam: z.string(),
  manufacturing_year: dateLike.describe("1º de janeiro do ano (UTC); só o ano conta."),
  model_year: dateLike.describe("1º de janeiro do ano (UTC); só o ano conta."),
  km_per_liter: z.number().describe("Até duas casas decimais."),
  number_of_axles: z.number().int(),
  status: statusEnum,
  vehicleTypeId: z.string().nullable(),
  fuelTypeId: z.string(),
  driverId: z.string().nullable().describe("O motorista responsável (fixo)."),
  branchId: z.string().nullable(),
  businessId: z.string(),
  created_at: dateLike,
  updated_at: dateLike,
  vehicleType: z.object({ description: z.string() }).nullable(),
  fuelType: z.object({ description: z.string() }).nullable(),
  driver: z.object({ name: z.string(), cnh: z.string() }).nullable(),
  branch: z.object({ corporate_reason: z.string() }).nullable(),
});

/** One line of the picker search, as a fleet reader receives it. */
const vehicleSearchItem = vehicleListItem
  .omit({ vehicleType: true, fuelType: true, branch: true, driver: true })
  .extend({
    driver: z
      .object({ name: z.string() })
      .nullable()
      .describe("O motorista responsável, para o seletor dizer de quem é o veículo."),
    vehicleType: z
      .object({
        description: z.string(),
        required_cnh_category: z
          .enum(["A", "B", "C", "D", "E", "AB", "AC", "AD", "AE"])
          .nullable(),
      })
      .nullable()
      .describe(
        "O tipo e a categoria de CNH que ele exige, para a atribuição avisar quando a do motorista não cobre (decisão 8.5).",
      ),
  })
  .partial()
  .required({ id: true, description: true, license_plate: true, status: true })
  .describe(
    "Quem tem leitura de veículos recebe o cadastro inteiro. Quem só entra pela escrita de Entregas (despacho) recebe apenas id, description, license_plate, brand, model, status, businessId, driverId, vehicleTypeId, driver.name e vehicleType (descrição e CNH exigida).",
  );

/** GET /vehicle/list-vehicle `meta.searchMeta`, as summarizeVehicleList builds it. */
const vehicleListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Veículos da busca e dos demais filtros, sem o de status (o total dos cartões)."),
    statusCounts: z
      .object({
        ACTIVE: z.number().int(),
        INACTIVE: z.number().int(),
        BLOCKED: z.number().int(),
        IN_ROUTE: z.number().int(),
      })
      .describe("Os quatro status sobre a mesma base de `total`; somam `total`."),
  },
  ["status", "branchId"],
);

const message = (text: string) => z.object({ message: z.string().default(text) });

const vehicleResponses = {
  vehicleCreated: message("Veículo criado com sucesso!"),
  vehicleUpdated: message("Veículo atualizado com sucesso!"),
  vehicleDeleted: message("Veículo deletado com sucesso!"),

  vehicleListItem,
  vehicleSearchItem,

  vehicleReturned: z.object({
    id: z.string().describe("ID do veículo"),
    description: z.string().describe("Descrição"),
    license_plate: z.string().describe("Placa, em maiúsculas"),
    brand: z.string().describe("Marca"),
    model: z.string().describe("Modelo"),
    acquisition_date: dateLike.describe("Data de aquisição"),
    fleet_type: z.enum(["OWNED", "THIRD_PARTY"]).describe("Frota própria ou terceirizada"),
    fleet_id: z.string().nullable().optional().describe("Identificador na frota"),
    last_maintenance_date: dateLike
      .nullable()
      .optional()
      .describe("Data da última manutenção"),
    current_mileage: z.number().describe("Quilometragem atual"),
    last_maintenance_mileage: z
      .number()
      .nullable()
      .optional()
      .describe("Quilometragem da última manutenção"),
    maintenance_interval_km: z.number().describe("Intervalo de revisão em km"),
    maintenance_interval_months: z.number().describe("Intervalo de revisão em meses"),
    renavam: z.string().describe("RENAVAM"),
    manufacturing_year: dateLike.describe("Ano de fabricação (1º de janeiro, UTC)"),
    model_year: dateLike.describe("Ano do modelo (1º de janeiro, UTC)"),
    km_per_liter: z.number().describe("Consumo em km/l, até duas casas decimais"),
    number_of_axles: z.number().describe("Número de eixos"),
    status: statusEnum,
    businessId: z.string().describe("ID da empresa"),
    vehicleTypeId: z.string().nullable().optional().describe("ID do tipo de veículo"),
    fuelTypeId: z.string().describe("ID do tipo de combustível"),
    driverId: z.string().nullable().optional().describe("ID do motorista responsável"),
    branchId: z.string().nullable().optional().describe("ID da filial"),
    last_fuel_mileage: z
      .number()
      .nullable()
      .optional()
      .describe("Quilometragem do último abastecimento"),
    last_fuel_date: dateLike
      .nullable()
      .optional()
      .describe("Data do último abastecimento"),
    created_at: dateLike.describe("Criado em"),
    updated_at: dateLike.describe("Atualizado em"),
  }),

  // Every refusal leaves in the handler's shape (`code` + `message`); the
  // descriptions list the codes a client branches on.
  validationError: errorResponse.describe(
    "VALIDATION_ERROR (campo inválido, ordenação ou filtro fora da lista), BUSINESS_NOT_IDENTIFIED (MASTER sem empresa), VEHICLE_MODEL_YEAR_INVALID, VEHICLE_MILEAGE_READ_ONLY, VEHICLE_MAINTENANCE_MILEAGE_INVALID, VEHICLE_STATUS_DERIVED ou um cadastro relacionado (tipo, combustível, motorista, filial) que não existe nesta empresa.",
  ),
  forbidden: errorResponse.describe(
    "PERMISSION_DENIED (inclui o motorista na listagem da frota) ou VEHICLE_NOT_ASSIGNED_TO_DRIVER (o motorista pediu um veículo que não é o dele nem o da rota liberada ou em andamento).",
  ),
  notFound: errorResponse.describe(
    "VEHICLE_NOT_FOUND, BUSINESS_NOT_FOUND ou USER_NOT_FOUND (o usuário da sessão não existe mais). Um veículo de outra empresa responde exatamente como um inexistente.",
  ),
  // The list only looks the session user up; no vehicle id to miss.
  sessionUserNotFound: errorResponse.describe(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),
  createConflict: errorResponse.describe(
    "VEHICLE_PLATE_TAKEN ou VEHICLE_RENAVAM_TAKEN (já existe nesta empresa) e VEHICLE_LIMIT_REACHED (frota contratada cheia).",
  ),
  updateConflict: errorResponse.describe(
    "VEHICLE_PLATE_TAKEN, VEHICLE_RENAVAM_TAKEN, VEHICLE_LIMIT_REACHED (reativação além do contrato), VEHICLE_IN_ACTIVE_ROUTE (com rota em andamento só é possível bloquear) ou VEHICLE_HAS_OPEN_ROUTES (inativar com rotas planejadas, liberadas ou em andamento; a mensagem traz as contagens).",
  ),
  deleteConflict: errorResponse.describe(
    "VEHICLE_IN_USE: multas, abastecimentos, OS, checklists, contas a pagar, entregas ou rotas ainda apontam para o veículo; a mensagem traz a contagem e o que fazer.",
  ),
  exportError: errorResponse.describe(
    "NOTHING_TO_EXPORT (nenhum veículo na busca e nos filtros) ou BUSINESS_NOT_IDENTIFIED.",
  ),
  internalServerError: errorResponse,
};

export { vehicleSchemas, vehicleResponses, vehicleListSearchMetaDoc };
