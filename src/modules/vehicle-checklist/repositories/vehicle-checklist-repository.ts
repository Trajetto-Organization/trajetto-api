import database from "@/../infra/database";
import { formatDate } from "@/config/format-values";

import { container } from "tsyringe";

import { UploadService } from "@/shared/services/upload-service";
import { IVehicleChecklistRepository } from "./IVehicle-checklist-repository";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistFormattedProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  ListVehicleChecklistBusinessProps,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistFormatted,
  VehicleChecklistWithRelationsFormatted,
} from "../dtos/vehicle-checklist-dto";

class VehicleChecklistRepository implements IVehicleChecklistRepository {
  private uploadService: UploadService;

  constructor(private prisma = database) {
    this.uploadService = container.resolve(UploadService);
  }

  async createVehicleChecklist(
    checklistData: CreateVehicleChecklistProps,
  ): Promise<VehicleChecklist> {
    const checklistCreated = await this.prisma.vehicleChecklist.create({
      data: {
        ...checklistData,
        photos: checklistData.photos,
        branchId: checklistData.branchId!,
        driverId: checklistData.driverId!,
      },
    });

    return checklistCreated;
  }

  async listVehicleChecklists({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
    vehicleId,
    driverId,
    overall_condition,
    startDate,
    endDate,
  }: ListVehicleChecklistByBusinessIdProps): Promise<ListVehicleChecklistFormattedProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { notes: { contains: normalizedSearch, mode: "insensitive" } },
        {
          vehicle: {
            OR: [
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                license_plate: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              { brand: { contains: normalizedSearch, mode: "insensitive" } },
              { model: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          driver: {
            OR: [
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          branch: {
            OR: [
              {
                corporate_reason: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                fantasy_name: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
      );
    }

    const whereConditions: any = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    // Add additional filters
    if (vehicleId) {
      whereConditions.vehicleId = vehicleId;
    }

    if (driverId) {
      whereConditions.driverId = driverId;
    }

    if (overall_condition) {
      whereConditions.overall_condition = overall_condition;
    }

    if (startDate && endDate) {
      whereConditions.checklist_date = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }

    const checklistsData = await this.prisma.vehicleChecklist.findMany({
      skip,
      take: pageSize,
      where: whereConditions,
      include: {
        business: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        vehicle: {
          select: {
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            current_mileage: true,
          },
        },
        driver: {
          select: {
            name: true,
            cnh: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.vehicleChecklist.count({
      where: whereConditions,
    });

    const transformedChecklistData: VehicleChecklistFormatted[] =
      checklistsData.map((checklist) => ({
        id: checklist.id ?? "N/A",
        current_mileage: checklist.current_mileage ?? 0,
        checklist_date: checklist.checklist_date ?? "N/A",
        tires_condition: checklist.tires_condition ?? "N/A",
        headlights_working: checklist.headlights_working ?? false,
        taillights_working: checklist.taillights_working ?? false,
        turn_signals_working: checklist.turn_signals_working ?? false,
        bumpers_condition: checklist.bumpers_condition ?? "N/A",
        windshield_condition: checklist.windshield_condition ?? "N/A",
        mirrors_condition: checklist.mirrors_condition ?? "N/A",
        seatbelts_working: checklist.seatbelts_working ?? false,
        dashboard_working: checklist.dashboard_working ?? false,
        steering_wheel_condition: checklist.steering_wheel_condition ?? "N/A",
        brakes_working: checklist.brakes_working ?? false,
        clutch_working: checklist.clutch_working ?? false,
        fuel_level_adequate: checklist.fuel_level_adequate ?? false,
        oil_level_adequate: checklist.oil_level_adequate ?? false,
        radiator_water_adequate: checklist.radiator_water_adequate ?? false,
        brake_fluid_adequate: checklist.brake_fluid_adequate ?? false,
        battery_condition: checklist.battery_condition ?? "N/A",
        driver_license_valid: checklist.driver_license_valid ?? false,
        vehicle_documents_valid: checklist.vehicle_documents_valid ?? false,
        insurance_valid: checklist.insurance_valid ?? false,
        fire_extinguisher_valid: checklist.fire_extinguisher_valid ?? false,
        warning_triangle_present: checklist.warning_triangle_present ?? false,
        jack_present: checklist.jack_present ?? false,
        spare_tire_condition: checklist.spare_tire_condition ?? "N/A",
        notes: checklist.notes ?? "N/A",
        photos: checklist.photos
          ? checklist.photos.map((photoPath: string) =>
              this.uploadService.getFileUrl(photoPath),
            )
          : [],
        overall_condition: checklist.overall_condition ?? "N/A",
        businessId: checklist.businessId ?? "N/A",
        branchId: checklist.branchId ?? "N/A",
        vehicleId: checklist.vehicleId ?? "N/A",
        driverId: checklist.driverId ?? "N/A",
        ...(currentUserRole === "MASTER"
          ? {
              business_name: checklist.business?.corporate_reason ?? "N/A",
            }
          : {}),
        branch_name: checklist.branch?.corporate_reason ?? "N/A",
        vehicle_description: checklist.vehicle?.description ?? "N/A",
        vehicle_license_plate: checklist.vehicle?.license_plate ?? "N/A",
        vehicle_brand: checklist.vehicle?.brand ?? "N/A",
        vehicle_model: checklist.vehicle?.model ?? "N/A",
        driver_name: checklist.driver?.name ?? "N/A",
        driver_cnh: checklist.driver?.cnh ?? "N/A",
        created_at: formatDate(checklist.created_at, "pt-BR") ?? "N/A",
        updated_at: formatDate(checklist.updated_at, "pt-BR") ?? "N/A",
      }));

    return {
      data: transformedChecklistData,
      total,
    };
  }

  async listVehicleChecklistBusiness({
    page,
    pageSize,
    businessId,
  }: ListVehicleChecklistBusinessProps): Promise<ListVehicleChecklistProps> {
    const skip = (page - 1) * pageSize;

    const [checklists, total] = await Promise.all([
      this.prisma.vehicleChecklist.findMany({
        where: {
          businessId,
        },
        skip,
        take: pageSize,
        orderBy: {
          created_at: "desc", // Sort by created_at
        },
      }),
      this.prisma.vehicleChecklist.count({
        where: {
          businessId,
        },
      }),
    ]);

    return {
      data: checklists,
      total,
    };
  }

  async updateVehicleChecklist({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist): Promise<VehicleChecklist> {
    // Filter out undefined values to prevent overwriting existing data with undefined
    const filteredData = Object.fromEntries(
      Object.entries(checklistData).filter(([_, value]) => value !== undefined),
    );

    const updatedChecklist = await this.prisma.vehicleChecklist.update({
      where: {
        id: checklistId,
      },
      data: filteredData,
    });

    return updatedChecklist;
  }

  async deleteVehicleChecklist(checklistId: string): Promise<VehicleChecklist> {
    const checklistToDelete = await this.prisma.vehicleChecklist.findUnique({
      where: { id: checklistId },
    });

    if (!checklistToDelete) {
      throw new Error("Checklist not found");
    }

    const deletedChecklist = await this.prisma.vehicleChecklist.delete({
      where: {
        id: checklistId,
      },
    });

    return deletedChecklist;
  }

  async findVehicleChecklistById(
    checklistId: string,
  ): Promise<VehicleChecklist | null> {
    const checklist = await this.prisma.vehicleChecklist.findUnique({
      where: {
        id: checklistId,
      },
    });

    return checklist;
  }

  async findVehicleChecklistByIdWithRelations(
    checklistId: string,
  ): Promise<VehicleChecklistWithRelationsFormatted | null> {
    const checklist = await this.prisma.vehicleChecklist.findUnique({
      where: {
        id: checklistId,
      },
      include: {
        business: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        branch: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            current_mileage: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cnh: true,
          },
        },
      },
    });

    if (!checklist) {
      return null;
    }

    return {
      id: checklist.id,
      current_mileage: checklist.current_mileage,
      checklist_date: formatDate(checklist.checklist_date, "pt-BR"),
      tires_condition: checklist.tires_condition,
      headlights_working: checklist.headlights_working,
      taillights_working: checklist.taillights_working,
      turn_signals_working: checklist.turn_signals_working,
      bumpers_condition: checklist.bumpers_condition,
      windshield_condition: checklist.windshield_condition,
      mirrors_condition: checklist.mirrors_condition,
      seatbelts_working: checklist.seatbelts_working,
      dashboard_working: checklist.dashboard_working,
      steering_wheel_condition: checklist.steering_wheel_condition,
      brakes_working: checklist.brakes_working,
      clutch_working: checklist.clutch_working,
      fuel_level_adequate: checklist.fuel_level_adequate,
      oil_level_adequate: checklist.oil_level_adequate,
      radiator_water_adequate: checklist.radiator_water_adequate,
      brake_fluid_adequate: checklist.brake_fluid_adequate,
      battery_condition: checklist.battery_condition,
      driver_license_valid: checklist.driver_license_valid,
      vehicle_documents_valid: checklist.vehicle_documents_valid,
      insurance_valid: checklist.insurance_valid,
      fire_extinguisher_valid: checklist.fire_extinguisher_valid,
      warning_triangle_present: checklist.warning_triangle_present,
      jack_present: checklist.jack_present,
      spare_tire_condition: checklist.spare_tire_condition,
      notes: checklist.notes,
      photos: checklist.photos
        ? checklist.photos.map((photoPath: string) =>
            this.uploadService.getFileUrl(photoPath),
          )
        : [],
      overall_condition: checklist.overall_condition,
      businessId: checklist.businessId,
      branchId: checklist.branchId,
      vehicleId: checklist.vehicleId,
      driverId: checklist.driverId,
      created_at: formatDate(checklist.created_at, "pt-BR"),
      updated_at: formatDate(checklist.updated_at, "pt-BR"),
      business: checklist.business,
      branch: checklist.branch,
      vehicle: checklist.vehicle,
      driver: checklist.driver,
    };
  }

  async getVehicleChecklistByIdAndBusiness({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklist | null> {
    const checklist = await this.prisma.vehicleChecklist.findFirst({
      where: {
        id: checklistId,
        businessId,
      },
    });

    return checklist;
  }

  async getVehicleChecklistByIdAndBusinessWithRelations({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklistWithRelationsFormatted | null> {
    const checklist = await this.prisma.vehicleChecklist.findFirst({
      where: {
        id: checklistId,
        businessId,
      },
      include: {
        business: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        branch: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            current_mileage: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cnh: true,
          },
        },
      },
    });

    if (!checklist) {
      return null;
    }

    return {
      id: checklist.id,
      current_mileage: checklist.current_mileage,
      checklist_date: formatDate(checklist.checklist_date, "pt-BR"),
      tires_condition: checklist.tires_condition,
      headlights_working: checklist.headlights_working,
      taillights_working: checklist.taillights_working,
      turn_signals_working: checklist.turn_signals_working,
      bumpers_condition: checklist.bumpers_condition,
      windshield_condition: checklist.windshield_condition,
      mirrors_condition: checklist.mirrors_condition,
      seatbelts_working: checklist.seatbelts_working,
      dashboard_working: checklist.dashboard_working,
      steering_wheel_condition: checklist.steering_wheel_condition,
      brakes_working: checklist.brakes_working,
      clutch_working: checklist.clutch_working,
      fuel_level_adequate: checklist.fuel_level_adequate,
      oil_level_adequate: checklist.oil_level_adequate,
      radiator_water_adequate: checklist.radiator_water_adequate,
      brake_fluid_adequate: checklist.brake_fluid_adequate,
      battery_condition: checklist.battery_condition,
      driver_license_valid: checklist.driver_license_valid,
      vehicle_documents_valid: checklist.vehicle_documents_valid,
      insurance_valid: checklist.insurance_valid,
      fire_extinguisher_valid: checklist.fire_extinguisher_valid,
      warning_triangle_present: checklist.warning_triangle_present,
      jack_present: checklist.jack_present,
      spare_tire_condition: checklist.spare_tire_condition,
      notes: checklist.notes,
      photos: checklist.photos
        ? checklist.photos.map((photoPath: string) =>
            this.uploadService.getFileUrl(photoPath),
          )
        : [],
      overall_condition: checklist.overall_condition,
      businessId: checklist.businessId,
      branchId: checklist.branchId,
      vehicleId: checklist.vehicleId,
      driverId: checklist.driverId,
      created_at: formatDate(checklist.created_at, "pt-BR"),
      updated_at: formatDate(checklist.updated_at, "pt-BR"),
      business: checklist.business,
      branch: checklist.branch,
      vehicle: checklist.vehicle,
      driver: checklist.driver,
    };
  }

  async findVehicleChecklistsByVehicleId(
    vehicleId: string,
  ): Promise<VehicleChecklist[]> {
    const checklists = await this.prisma.vehicleChecklist.findMany({
      where: {
        vehicleId,
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return checklists;
  }

  async findVehicleChecklistsByDriverId(
    driverId: string,
  ): Promise<VehicleChecklist[]> {
    const checklists = await this.prisma.vehicleChecklist.findMany({
      where: {
        driverId,
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return checklists;
  }

  async getAllVehicleChecklistsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): Promise<any[]> {
    const whereConditions: any = {
      businessId,
    };

    if (search) {
      whereConditions.OR = [
        {
          vehicle: {
            license_plate: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
        {
          vehicle: {
            description: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
        {
          driver: {
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
        {
          notes: {
            contains: search,
            mode: "insensitive",
          },
        },
      ];
    }

    const checklists = await this.prisma.vehicleChecklist.findMany({
      where: whereConditions,
      include: {
        business: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        vehicle: {
          select: {
            description: true,
            license_plate: true,
            brand: true,
            model: true,
          },
        },
        driver: {
          select: {
            name: true,
            cnh: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return checklists.map((checklist) => ({
      ID: checklist.id,
      "Data do Checklist": formatDate(checklist.checklist_date, "pt-BR"),
      "Quilometragem Atual": checklist.current_mileage,
      Veículo: checklist.vehicle.description,
      Placa: checklist.vehicle.license_plate,
      Marca: checklist.vehicle.brand,
      Modelo: checklist.vehicle.model,
      Motorista: checklist.driver.name,
      CNH: checklist.driver.cnh,
      Filial:
        checklist.branch.fantasy_name || checklist.branch.corporate_reason,
      "Condição dos Pneus": checklist.tires_condition,
      Faróis: checklist.headlights_working ? "OK" : "NOK",
      Lanternas: checklist.taillights_working ? "OK" : "NOK",
      Setas: checklist.turn_signals_working ? "OK" : "NOK",
      "Para-choques": checklist.bumpers_condition,
      "Para-brisa": checklist.windshield_condition,
      Retrovisores: checklist.mirrors_condition,
      "Cintos de Segurança": checklist.seatbelts_working ? "OK" : "NOK",
      Painel: checklist.dashboard_working ? "OK" : "NOK",
      Volante: checklist.steering_wheel_condition,
      Freios: checklist.brakes_working ? "OK" : "NOK",
      Embreagem: checklist.clutch_working ? "OK" : "NOK",
      "Nível de Combustível": checklist.fuel_level_adequate ? "OK" : "NOK",
      "Nível de Óleo": checklist.oil_level_adequate ? "OK" : "NOK",
      "Água do Radiador": checklist.radiator_water_adequate ? "OK" : "NOK",
      "Fluido de Freio": checklist.brake_fluid_adequate ? "OK" : "NOK",
      Bateria: checklist.battery_condition,
      "CNH Válida": checklist.driver_license_valid ? "OK" : "NOK",
      "Documentos do Veículo": checklist.vehicle_documents_valid ? "OK" : "NOK",
      Seguro: checklist.insurance_valid ? "OK" : "NOK",
      Extintor: checklist.fire_extinguisher_valid ? "OK" : "NOK",
      Triângulo: checklist.warning_triangle_present ? "OK" : "NOK",
      Macaco: checklist.jack_present ? "OK" : "NOK",
      Estepe: checklist.spare_tire_condition,
      "Condição Geral": checklist.overall_condition,
      Observações: checklist.notes || "",
      "Criado em": formatDate(checklist.created_at, "pt-BR"),
    }));
  }
}

export { VehicleChecklistRepository };
