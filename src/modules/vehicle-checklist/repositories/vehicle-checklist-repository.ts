import database from "@/../infra/database";
import { IVehicleChecklistRepository } from "./IVehicle-checklist-repository";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  ListVehicleChecklistBusinessProps,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
} from "../dtos/vehicle-checklist-dto";

class VehicleChecklistRepository implements IVehicleChecklistRepository {
  constructor(private prisma = database) {}

  // Helper function to format condition values for export
  private formatCondition(condition: string | null | undefined): string {
    if (!condition) return "N/A";

    const conditionMap: Record<string, string> = {
      approved: "Aprovado",
      approved_with_restrictions: "Aprovado com Restrições",
      rejected: "Rejeitado",
      good: "Boa",
      fair: "Regular",
      poor: "Ruim",
      bad: "Ruim",
      needs_attention: "Precisa de Atenção",
    };

    return conditionMap[condition] || condition;
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
  }: ListVehicleChecklistByBusinessIdProps): Promise<ListVehicleChecklistProps> {
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
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
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
              { id: { contains: normalizedSearch, mode: "insensitive" } },
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          branch: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
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
        // Business ID and name (MASTER only)
        ...(currentUserRole === "MASTER"
          ? [
              {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              },
            ]
          : []),
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

    return {
      data: checklistsData,
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
  ): Promise<VehicleChecklistWithRelations | null> {
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

    return checklist;
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
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklistWithRelations | null> {
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

    return checklist;
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
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
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
              { id: { contains: normalizedSearch, mode: "insensitive" } },
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          branch: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
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
        // Business ID and name (MASTER only)
        ...(userRole === "MASTER"
          ? [
              {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(userRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const checklists = await this.prisma.vehicleChecklist.findMany({
      where: whereCondition,
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
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
        created_at: "desc",
      },
    });

    return checklists.map((checklist) => ({
      id: checklist.id,
      vehicleLicensePlate: checklist.vehicle?.license_plate || "N/A",
      vehicleDescription: checklist.vehicle?.description || "N/A",
      vehicleBrand: checklist.vehicle?.brand || "N/A",
      vehicleModel: checklist.vehicle?.model || "N/A",
      vehicleCurrentMileage: checklist.vehicle?.current_mileage || 0,
      driverName: checklist.driver?.name || "N/A",
      driverCnh: checklist.driver?.cnh || "N/A",
      checklist_date: checklist.checklist_date,
      current_mileage: checklist.current_mileage || 0,
      tires_condition: this.formatCondition(checklist.tires_condition),
      headlights_working: checklist.headlights_working ? "OK" : "NOK",
      taillights_working: checklist.taillights_working ? "OK" : "NOK",
      turn_signals_working: checklist.turn_signals_working ? "OK" : "NOK",
      bumpers_condition: this.formatCondition(checklist.bumpers_condition),
      windshield_condition: this.formatCondition(
        checklist.windshield_condition,
      ),
      mirrors_condition: this.formatCondition(checklist.mirrors_condition),
      seatbelts_working: checklist.seatbelts_working ? "OK" : "NOK",
      dashboard_working: checklist.dashboard_working ? "OK" : "NOK",
      steering_wheel_condition: this.formatCondition(
        checklist.steering_wheel_condition,
      ),
      brakes_working: checklist.brakes_working ? "OK" : "NOK",
      clutch_working: checklist.clutch_working ? "OK" : "NOK",
      fuel_level_adequate: checklist.fuel_level_adequate ? "OK" : "NOK",
      oil_level_adequate: checklist.oil_level_adequate ? "OK" : "NOK",
      radiator_water_adequate: checklist.radiator_water_adequate ? "OK" : "NOK",
      brake_fluid_adequate: checklist.brake_fluid_adequate ? "OK" : "NOK",
      battery_condition: this.formatCondition(checklist.battery_condition),
      driver_license_valid: checklist.driver_license_valid ? "OK" : "NOK",
      vehicle_documents_valid: checklist.vehicle_documents_valid ? "OK" : "NOK",
      insurance_valid: checklist.insurance_valid ? "OK" : "NOK",
      fire_extinguisher_valid: checklist.fire_extinguisher_valid ? "OK" : "NOK",
      warning_triangle_present: checklist.warning_triangle_present
        ? "OK"
        : "NOK",
      jack_present: checklist.jack_present ? "OK" : "NOK",
      spare_tire_condition: this.formatCondition(
        checklist.spare_tire_condition,
      ),
      overall_condition: this.formatCondition(checklist.overall_condition),
      notes: checklist.notes || "N/A",
      branchName: checklist.branch?.corporate_reason || "N/A",
      ...(userRole === "MASTER" && {
        businessName: checklist.business?.corporate_reason || "N/A",
      }),
      created_at: checklist.created_at,
      updated_at: checklist.updated_at,
    }));
  }
}

export { VehicleChecklistRepository };
