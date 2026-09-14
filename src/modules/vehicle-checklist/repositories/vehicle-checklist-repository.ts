import database from "@/../infra/database";
import { Prisma } from "@prisma/client";
import { IVehicleChecklistRepository } from "./IVehicle-checklist-repository";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
} from "../dtos/vehicle-checklist-dto";

class VehicleChecklistRepository implements IVehicleChecklistRepository {
  constructor(private prisma = database) {}

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

  async findBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<VehicleChecklist | null> {
    return this.prisma.vehicleChecklist.findFirst({
      where: {
        businessId,
        client_submission_id: clientSubmissionId,
      },
    });
  }

  // `afterCreate` runs inside the same transaction, only when this call
  // actually created the record — an idempotent retry returns the original
  // row and never fires it. It is how the use case publishes the outbox
  // event atomically without this method giving up its serializable retry.
  async createVehicleChecklistWithMileage(
    checklistData: CreateVehicleChecklistProps,
    afterCreate?: (
      tx: Prisma.TransactionClient,
      checklist: VehicleChecklist,
    ) => Promise<void>,
  ): Promise<{ checklist: VehicleChecklist; created: boolean }> {
    const executeTransaction = async () =>
      this.prisma.$transaction(
        async (transaction) => {
          if (checklistData.client_submission_id) {
            const existing = await transaction.vehicleChecklist.findFirst({
              where: {
                businessId: checklistData.businessId,
                client_submission_id: checklistData.client_submission_id,
              },
            });

            if (existing) {
              return { checklist: existing, created: false };
            }
          }

          const mileageUpdate = await transaction.vehicle.updateMany({
            where: {
              id: checklistData.vehicleId,
              businessId: checklistData.businessId,
              current_mileage: { lt: checklistData.current_mileage },
            },
            data: { current_mileage: checklistData.current_mileage },
          });

          if (mileageUpdate.count !== 1) {
            throw new VehicleMileageInvalidError();
          }

          const checklist = await transaction.vehicleChecklist.create({
            data: {
              ...checklistData,
              photos: checklistData.photos,
              branchId: checklistData.branchId!,
              driverId: checklistData.driverId!,
            },
          });

          if (afterCreate) {
            await afterCreate(transaction, checklist);
          }

          return { checklist, created: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await executeTransaction();
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          checklistData.client_submission_id
        ) {
          const existing = await this.findBySubmissionId(
            checklistData.businessId,
            checklistData.client_submission_id,
          );

          if (existing) return { checklist: existing, created: false };
        }

        const shouldRetry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 2;

        if (!shouldRetry) throw error;
      }
    }

    throw new Error("Could not complete checklist transaction");
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

    const [checklistsData, total] = await Promise.all([
      this.prisma.vehicleChecklist.findMany({
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
      }),
      this.prisma.vehicleChecklist.count({
        where: whereConditions,
      }),
    ]);

    return {
      data: checklistsData,
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

  async updateVehicleChecklistAndMileage(
    { checklistData, checklistId }: UpdateVehicleChecklist,
    mileageUpdate?: {
      businessId: string;
      vehicleId: string;
      currentMileage: number;
    },
  ): Promise<VehicleChecklist> {
    return this.prisma.$transaction(
      async (transaction) => {
        if (mileageUpdate) {
          const updatedMileage = await transaction.vehicle.updateMany({
            where: {
              id: mileageUpdate.vehicleId,
              businessId: mileageUpdate.businessId,
              current_mileage: { lt: mileageUpdate.currentMileage },
            },
            data: { current_mileage: mileageUpdate.currentMileage },
          });

          if (updatedMileage.count !== 1) {
            throw new VehicleMileageInvalidError();
          }
        }

        const filteredData = Object.fromEntries(
          Object.entries(checklistData).filter(
            ([, value]) => value !== undefined,
          ),
        );

        return transaction.vehicleChecklist.update({
          where: { id: checklistId },
          data: filteredData,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
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

  async *streamChecklistsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
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

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const checklists: any = await this.prisma.vehicleChecklist.findMany({
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
          id: "asc",
        },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (checklists.length === 0) break;
      for (const checklist of checklists) {
        yield {
          id: checklist.id,
          vehicleLicensePlate: checklist.vehicle?.license_plate,
          vehicleDescription: checklist.vehicle?.description,
          vehicleBrand: checklist.vehicle?.brand,
          vehicleModel: checklist.vehicle?.model,
          vehicleCurrentMileage: checklist.vehicle?.current_mileage,
          driverName: checklist.driver?.name,
          driverCnh: checklist.driver?.cnh,
          checklist_date: checklist.checklist_date,
          current_mileage: checklist.current_mileage,
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
          overall_condition: checklist.overall_condition,
          notes: checklist.notes,
          branchName: checklist.branch?.corporate_reason,
          ...(userRole === "MASTER" && {
            businessName: checklist.business?.corporate_reason,
          }),
          created_at: checklist.created_at,
          updated_at: checklist.updated_at,
        };
      }

      cursor = checklists[checklists.length - 1].id;
    }
  }

  async countChecklistForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
    };

    const checklistsCount = await this.prisma.vehicleChecklist.count({
      where: whereCondition,
    });

    return checklistsCount;
  }
}

export { VehicleChecklistRepository };
