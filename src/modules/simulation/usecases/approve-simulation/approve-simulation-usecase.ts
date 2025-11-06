import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ISimulationRepository } from "../../repositories/ISimulation-repository";

import { IRouteRepository } from "@/modules/routing/repositories/IRoute-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { SimulationNotFoundError } from "../errors/simulation-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { sendNotificationToUser } from "@/websocket";

interface ApproveSimulationRequest {
  simulationId: string;
}

@injectable()
class ApproveSimulationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
  ) {}

  async execute(
    data: ApproveSimulationRequest,
    userId: string,
  ): Promise<{ message: string; routesCreated: number }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Find simulation
    const findSimulation = await this.simulation.findById(data.simulationId);

    if (!findSimulation) {
      throw new SimulationNotFoundError();
    }

    // Validate permissions (multi-tenancy)
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findSimulation.businessId) {
        throw new AppError("Sem permissão para aprovar esta simulação!", 403);
      }
    }

    // Check if simulation is completed
    if (findSimulation.status !== "completed") {
      throw new AppError(
        "Apenas simulações concluídas podem ser aprovadas!",
        400,
      );
    }

    // Check if simulation has results
    if (!findSimulation.results || !findSimulation.results.routes) {
      throw new AppError(
        "Esta simulação não possui resultados para aprovar!",
        400,
      );
    }

    try {
      // Create real routes from simulation results
      const createdRoutes = [];

      for (const simulationRoute of findSimulation.results.routes) {
        const createdRoute = await this.route.createRoute({
          name: simulationRoute.name || "Rota Aprovada",
          description: `Rota aprovada da simulação: ${findSimulation.name}`,
          origin: simulationRoute.origin,
          destination: simulationRoute.destination,
          waypoints: simulationRoute.waypoints,
          distance: simulationRoute.distance,
          duration: simulationRoute.duration,
          geometry: simulationRoute.geometry,
          estimatedCost: simulationRoute.estimatedCost,
          status: "PENDING",
          businessId: findSimulation.businessId,
          vehicleId: simulationRoute.vehicleId,
          driverId: simulationRoute.driverId,
        });

        createdRoutes.push(createdRoute);
      }

      // Update simulation status to "approved"
      await this.simulation.update({
        id: data.simulationId,
        status: "approved",
        metadata: {
          ...findSimulation.metadata,
          approvedAt: new Date().toISOString(),
          approvedBy: userId,
          routesCreated: createdRoutes.length,
        },
      });

      // Send WebSocket notification
      sendNotificationToUser(userId, {
        type: "simulation_approved",
        businessId: findSimulation.businessId,
        data: {
          simulationId: data.simulationId,
          routesCreated: createdRoutes.length,
          message: "Simulação aprovada com sucesso!",
        },
      });

      return {
        message: "Simulação aprovada e rotas criadas com sucesso!",
        routesCreated: createdRoutes.length,
      };
    } catch (error) {
      console.error("[ApproveSimulationUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar aprovar a simulação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ApproveSimulationUseCase };
