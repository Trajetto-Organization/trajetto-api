import database from "@/../infra/database";
import { ISimulationRepository } from "./ISimulation-repository";

import {
  Simulation,
  CreateSimulationProps,
  UpdateSimulationProps,
  ListSimulationsProps,
  ListSimulationsResult,
  SimulationResults,
} from "../dtos/simulation-dto";

class SimulationRepository implements ISimulationRepository {
  constructor(private prisma = database) {}

  async create(data: CreateSimulationProps): Promise<Simulation> {
    const simulation = await this.prisma.simulation.create({
      data: {
        name: data.name,
        description: data.description,
        status: "pending",
        businessId: data.businessId,
        metadata: (data.metadata || {}) as any,
      },
    });

    return this.transformSimulationData(simulation);
  }

  async listByBusiness(props: ListSimulationsProps): Promise<ListSimulationsResult> {
    const skip = (props.page - 1) * props.pageSize;
    const normalizedSearch = props.search ? props.search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
      );
    }

    const whereCondition: any = {
      ...(props.currentUserRole !== "MASTER" && { businessId: props.businessId }),
      ...(props.status && { status: props.status }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [simulationData, total] = await Promise.all([
      this.prisma.simulation.findMany({
        skip,
        take: props.pageSize,
        where: whereCondition,
        include: {
          business: {
            select: {
              corporate_reason: true,
            },
          },
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.simulation.count({ where: whereCondition }),
    ]);

    const transformedSimulationData = simulationData.map((simulation) => {
      const results = simulation.results as any;

      return {
        id: simulation.id ?? "N/A",
        name: simulation.name ?? "N/A",
        description: simulation.description ?? "N/A",
        status: simulation.status ?? "N/A",
        totalDistance: results?.totalDistance ?? 0,
        totalDuration: results?.totalDuration ?? 0,
        totalCost: results?.totalCost ?? 0,
        routesCount: results?.routes?.length ?? 0,
        businessId: simulation.businessId ?? "N/A",
        ...(props.currentUserRole === "MASTER"
          ? { business_name: simulation.business?.corporate_reason ?? "N/A" }
          : {}),
        created_at: simulation.created_at,
        updated_at: simulation.updated_at,
      };
    });

    return {
      data: transformedSimulationData,
      total,
    };
  }

  async findById(id: string): Promise<Simulation | null> {
    const simulation = await this.prisma.simulation.findUnique({
      where: { id },
      include: {
        routes: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            waypoints: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
      },
    });

    if (!simulation) return null;

    return this.transformSimulationData(simulation);
  }

  async findByBusinessAndId(
    simulationId: string,
    businessId: string,
  ): Promise<Simulation | null> {
    const simulation = await this.prisma.simulation.findFirst({
      where: {
        id: simulationId,
        businessId,
      },
      include: {
        routes: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            waypoints: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
      },
    });

    if (!simulation) return null;

    return this.transformSimulationData(simulation);
  }

  async update(props: UpdateSimulationProps): Promise<Simulation> {
    const simulation = await this.prisma.simulation.update({
      where: { id: props.id },
      data: {
        name: props.name,
        description: props.description,
        status: props.status,
        results: props.results as any,
        metadata: props.metadata as any,
      },
      include: {
        routes: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            waypoints: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
      },
    });

    return this.transformSimulationData(simulation);
  }

  async delete(id: string): Promise<Simulation> {
    const simulation = await this.prisma.simulation.delete({
      where: { id },
    });

    return this.transformSimulationData(simulation);
  }

  async updateStatus(id: string, status: string): Promise<Simulation> {
    const simulation = await this.prisma.simulation.update({
      where: { id },
      data: { status },
    });

    return this.transformSimulationData(simulation);
  }

  async updateResults(
    id: string,
    results: SimulationResults,
  ): Promise<Simulation> {
    const simulation = await this.prisma.simulation.update({
      where: { id },
      data: { results: results as any },
    });

    return this.transformSimulationData(simulation);
  }

  async countByBusiness(businessId: string): Promise<number> {
    return this.prisma.simulation.count({
      where: { businessId },
    });
  }

  async findByStatus(
    status: string,
    businessId?: string,
  ): Promise<Simulation[]> {
    const whereCondition: any = { status };

    if (businessId) {
      whereCondition.businessId = businessId;
    }

    const simulations = await this.prisma.simulation.findMany({
      where: whereCondition,
      include: {
        routes: {
          select: {
            id: true,
            name: true,
            origin: true,
            destination: true,
            waypoints: true,
            distance: true,
            duration: true,
            estimatedCost: true,
          },
        },
      },
    });

    return simulations.map((simulation) =>
      this.transformSimulationData(simulation),
    );
  }

  private transformSimulationData(data: any): Simulation {
    return {
      id: data.id,
      name: data.name,
      description: data.description,
      status: data.status,
      results: data.results as SimulationResults | null,
      metadata: (data.metadata as Record<string, unknown>) || {},
      businessId: data.businessId,
      created_at: data.created_at,
      updated_at: data.updated_at,
      routes: data.routes
        ? data.routes.map((route: any) => ({
            id: route.id,
            name: route.name,
            origin: route.origin,
            destination: route.destination,
            waypoints: route.waypoints || [],
            distance: route.distance,
            duration: route.duration,
            estimatedCost:
              typeof route.estimatedCost === "object"
                ? parseFloat(route.estimatedCost.toString())
                : route.estimatedCost,
          }))
        : undefined,
    };
  }
}

export { SimulationRepository };
