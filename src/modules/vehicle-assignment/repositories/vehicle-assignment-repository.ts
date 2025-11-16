import database from "@/../infra/database";
import { IVehicleAssignmentRepository } from "./IVehicleAssignment-repository";

import {
  VehicleAssignment,
  CreateVehicleAssignmentProps,
  UpdateVehicleAssignmentProps,
  ListVehicleAssignmentsProps,
  ListVehicleAssignmentsResult,
} from "../dtos/vehicle-assignment-dto";

class VehicleAssignmentRepository implements IVehicleAssignmentRepository {
  constructor(private prisma = database) {}

  async createAssignment(
    data: CreateVehicleAssignmentProps,
  ): Promise<VehicleAssignment> {
    const assignment = await this.prisma.vehicleAssignment.create({
      data: {
        routeId: data.routeId,
        vehicleId: data.vehicleId,
        driverId: data.driverId,
        scheduledDate: new Date(data.scheduledDate),
        status: data.status || "pending",
        notes: data.notes,
        businessId: data.businessId,
      },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
    });

    return this.transformAssignmentData(assignment);
  }

  async listAssignments(
    props: ListVehicleAssignmentsProps,
  ): Promise<ListVehicleAssignmentsResult> {
    const page = props.page || 1;
    const limit = props.limit || 10;

    const skip = (page - 1) * limit;

    const whereCondition: any = {
      businessId: props.businessId,
    };

    if (props.status) {
      whereCondition.status = props.status;
    }

    if (props.vehicleId) {
      whereCondition.vehicleId = props.vehicleId;
    }

    if (props.driverId) {
      whereCondition.driverId = props.driverId;
    }

    if (props.search) {
      whereCondition.OR = [
        { id: { contains: props.search, mode: "insensitive" } },
        { status: { contains: props.search, mode: "insensitive" } },
        { notes: { contains: props.search, mode: "insensitive" } },
      ];
    }

    const assignments = await this.prisma.vehicleAssignment.findMany({
      skip,
      take: limit,
      where: whereCondition,
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
      orderBy: {
        scheduledDate: "desc",
      },
    });

    const total = await this.prisma.vehicleAssignment.count({
      where: whereCondition,
    });

    return {
      data: assignments.map((assignment) =>
        this.transformAssignmentData(assignment),
      ),
      total,
    };
  }

  async findAssignmentById(id: string): Promise<VehicleAssignment | null> {
    const assignment = await this.prisma.vehicleAssignment.findUnique({
      where: { id },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
    });

    if (!assignment) return null;

    return this.transformAssignmentData(assignment);
  }

  async findAssignmentByBusinessAndId(
    assignmentId: string,
    businessId: string,
  ): Promise<VehicleAssignment | null> {
    const assignment = await this.prisma.vehicleAssignment.findFirst({
      where: {
        id: assignmentId,
        businessId,
      },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
    });

    if (!assignment) return null;

    return this.transformAssignmentData(assignment);
  }

  async updateAssignment(
    props: UpdateVehicleAssignmentProps,
  ): Promise<VehicleAssignment> {
    const updateData: any = {};

    if (props.vehicleId !== undefined) updateData.vehicleId = props.vehicleId;
    if (props.driverId !== undefined) updateData.driverId = props.driverId;
    if (props.scheduledDate !== undefined)
      updateData.scheduledDate = new Date(props.scheduledDate);
    if (props.status !== undefined) updateData.status = props.status;
    if (props.notes !== undefined) updateData.notes = props.notes;

    const assignment = await this.prisma.vehicleAssignment.update({
      where: { id: props.id },
      data: updateData,
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
    });

    return this.transformAssignmentData(assignment);
  }

  async deleteAssignment(id: string): Promise<VehicleAssignment> {
    const assignment = await this.prisma.vehicleAssignment.delete({
      where: { id },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
    });

    return this.transformAssignmentData(assignment);
  }

  async findAssignmentsByRoute(routeId: string): Promise<VehicleAssignment[]> {
    const assignments = await this.prisma.vehicleAssignment.findMany({
      where: { routeId },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
      orderBy: {
        scheduledDate: "desc",
      },
    });

    return assignments.map((assignment) =>
      this.transformAssignmentData(assignment),
    );
  }

  async findAssignmentsByVehicle(
    vehicleId: string,
  ): Promise<VehicleAssignment[]> {
    const assignments = await this.prisma.vehicleAssignment.findMany({
      where: { vehicleId },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
      orderBy: {
        scheduledDate: "desc",
      },
    });

    return assignments.map((assignment) =>
      this.transformAssignmentData(assignment),
    );
  }

  async findAssignmentsByDriver(
    driverId: string,
  ): Promise<VehicleAssignment[]> {
    const assignments = await this.prisma.vehicleAssignment.findMany({
      where: { driverId },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
      orderBy: {
        scheduledDate: "desc",
      },
    });

    return assignments.map((assignment) =>
      this.transformAssignmentData(assignment),
    );
  }

  async findByVehicleAndDate(
    vehicleId: string,
    scheduledDate: Date,
  ): Promise<VehicleAssignment | null> {
    const startOfDay = new Date(scheduledDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(scheduledDate);
    endOfDay.setHours(23, 59, 59, 999);

    const assignment = await this.prisma.vehicleAssignment.findFirst({
      where: {
        vehicleId,
        scheduledDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        status: {
          not: "cancelled",
        },
      },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            status: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cpf: true,
          },
        },
      },
    });

    if (!assignment) return null;

    return this.transformAssignmentData(assignment);
  }

  async countAssignmentsByBusiness(businessId: string): Promise<number> {
    return await this.prisma.vehicleAssignment.count({
      where: { businessId },
    });
  }

  private transformAssignmentData(assignment: any): VehicleAssignment {
    return {
      id: assignment.id,
      routeId: assignment.routeId,
      vehicleId: assignment.vehicleId,
      driverId: assignment.driverId,
      scheduledDate:
        assignment.scheduledDate instanceof Date
          ? assignment.scheduledDate
          : new Date(assignment.scheduledDate),
      status: assignment.status,
      notes: assignment.notes,
      businessId: assignment.businessId,
      created_at:
        assignment.created_at instanceof Date
          ? assignment.created_at
          : new Date(assignment.created_at),
      updated_at:
        assignment.updated_at instanceof Date
          ? assignment.updated_at
          : new Date(assignment.updated_at),
      route: assignment.route
        ? {
            id: assignment.route.id,
            name: assignment.route.name,
            origin: assignment.route.origin as any,
            destination: assignment.route.destination as any,
            distance: assignment.route.distance,
            duration: assignment.route.duration,
            estimatedCost: assignment.route.estimatedCost
              ? Number(assignment.route.estimatedCost)
              : 0,
          }
        : undefined,
      vehicle: assignment.vehicle
        ? {
            id: assignment.vehicle.id,
            description: assignment.vehicle.description,
            license_plate: assignment.vehicle.license_plate,
            brand: assignment.vehicle.brand,
            model: assignment.vehicle.model,
            status: assignment.vehicle.status,
          }
        : undefined,
      driver: assignment.driver
        ? {
            id: assignment.driver.id,
            name: assignment.driver.name,
            cpf: assignment.driver.cpf,
          }
        : null,
    };
  }
}

export { VehicleAssignmentRepository };
