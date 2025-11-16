import database from "@/../infra/database";
import { IRouteRepository } from "./IRoute-repository";

import {
  Route,
  CreateRouteProps,
  UpdateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  Coordinate,
} from "../dtos/route-dto";
import { Decimal } from "@prisma/client/runtime/library";

class RouteRepository implements IRouteRepository {
  constructor(private prisma = database) {}

  async createRoute(data: CreateRouteProps): Promise<Route> {
    const route = await this.prisma.route.create({
      data: {
        name: data.name,
        description: data.description,
        origin: data.origin as any,
        destination: data.destination as any,
        waypoints: (data.waypoints || []) as any,
        distance: data.distance as number,
        duration: data.duration as number,
        geometry: data.geometry as any,
        estimatedCost: new Decimal(data.estimatedCost as number),
        status: data.status || "pending",
        businessId: data.businessId,
        vehicleId: data.vehicleId,
        driverId: data.driverId,
        simulationId: data.simulationId,
        metadata: (data.metadata || {}) as any,
      },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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

    return this.transformRouteData(route);
  }

  async listRoutes(props: ListRoutesProps): Promise<ListRoutesResult> {
    const page = props.page || 1;
    const limit = props.limit || 10;

    const skip = (page - 1) * limit;

    const whereCondition: any = {
      businessId: props.businessId,
    };

    if (props.status) {
      whereCondition.status = props.status;
    }

    if (props.search) {
      whereCondition.OR = [
        { id: { contains: props.search, mode: "insensitive" } },
        { status: { contains: props.search, mode: "insensitive" } },
      ];
    }

    const routes = await this.prisma.route.findMany({
      skip,
      take: limit,
      where: whereCondition,
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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
        created_at: "desc",
      },
    });

    const total = await this.prisma.route.count({
      where: whereCondition,
    });

    return {
      data: routes.map((route) => this.transformRouteData(route)),
      total,
    };
  }

  async findRouteById(id: string): Promise<Route | null> {
    const route = await this.prisma.route.findUnique({
      where: { id },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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

    if (!route) return null;
    return this.transformRouteData(route);
  }

  async findRouteByBusinessAndId(
    routeId: string,
    businessId: string,
  ): Promise<Route | null> {
    const route = await this.prisma.route.findFirst({
      where: {
        id: routeId,
        businessId,
      },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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

    if (!route) return null;

    return this.transformRouteData(route);
  }

  async updateRoute(props: UpdateRouteProps): Promise<Route> {
    const updateData: any = {};

    if (props.name !== undefined) updateData.name = props.name;
    if (props.description !== undefined)
      updateData.description = props.description;

    if (props.origin) updateData.origin = props.origin;
    if (props.destination) updateData.destination = props.destination;

    if (props.waypoints) updateData.waypoints = props.waypoints;

    if (props.distance !== undefined) updateData.distance = props.distance;
    if (props.duration !== undefined) updateData.duration = props.duration;

    if (props.geometry) updateData.geometry = props.geometry;
    if (props.estimatedCost !== undefined)
      updateData.estimatedCost = new Decimal(props.estimatedCost);

    if (props.status) updateData.status = props.status;

    if (props.vehicleId !== undefined) updateData.vehicleId = props.vehicleId;
    if (props.driverId !== undefined) updateData.driverId = props.driverId;

    if (props.metadata) updateData.metadata = props.metadata;

    const route = await this.prisma.route.update({
      where: { id: props.id },
      data: updateData,
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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

    return this.transformRouteData(route);
  }

  async deleteRoute(id: string): Promise<Route> {
    const route = await this.prisma.route.delete({
      where: { id },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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

    return this.transformRouteData(route);
  }

  async findRoutesBySimulation(simulationId: string): Promise<Route[]> {
    const routes = await this.prisma.route.findMany({
      where: { simulationId },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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
        created_at: "desc",
      },
    });

    return routes.map((route) => this.transformRouteData(route));
  }

  async findRoutesByVehicle(vehicleId: string): Promise<Route[]> {
    const routes = await this.prisma.route.findMany({
      where: { vehicleId },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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
        created_at: "desc",
      },
    });

    return routes.map((route) => this.transformRouteData(route));
  }

  async findRoutesByDriver(driverId: string): Promise<Route[]> {
    const routes = await this.prisma.route.findMany({
      where: { driverId },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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
        created_at: "desc",
      },
    });

    return routes.map((route) => this.transformRouteData(route));
  }

  async countRoutesByBusiness(businessId: string): Promise<number> {
    return await this.prisma.route.count({
      where: { businessId },
    });
  }

  // Helper method to transform Prisma data → DTO
  // Analytics methods
  async findRoutesByDateRange(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Route[]> {
    const routes = await this.prisma.route.findMany({
      where: {
        businessId,
        created_at: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
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
        created_at: "desc",
      },
    });

    return routes.map((route) => this.transformRouteData(route));
  }

  async getTotalDistanceByDateRange(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    const result = await this.prisma.route.aggregate({
      where: {
        businessId,
        created_at: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        distance: true,
      },
    });

    return result._sum.distance || 0;
  }

  private transformRouteData(route: any): Route {
    return {
      id: route.id,
      name: route.name,
      description: route.description,
      origin: route.origin as Coordinate,
      destination: route.destination as Coordinate,
      waypoints: (route.waypoints as Coordinate[]) || [],
      distance: route.distance,
      duration: route.duration,
      geometry: route.geometry as { type: string; coordinates: number[][] },
      estimatedCost: route.estimatedCost,
      status: route.status,
      businessId: route.businessId,
      vehicleId: route.vehicleId,
      driverId: route.driverId,
      simulationId: route.simulationId,
      metadata: (route.metadata as Record<string, unknown>) || {},
      created_at: route.created_at,
      updated_at: route.updated_at,
      vehicle: route.vehicle || undefined,
      driver: route.driver || undefined,
    };
  }
}

export { RouteRepository };
