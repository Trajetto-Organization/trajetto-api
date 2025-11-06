import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ISimulationRepository } from "../../repositories/ISimulation-repository";
import { IRoutingProvider } from "@/shared/providers/routing-provider/IRouting-provider";

import FleetCommandWorkerService from "@/shared/services/fleet-command-worker-service";
import { NotificationService } from "@/shared/services/notification-service";

import { sendNotificationToUser } from "@/websocket";

import {
  RunSimulationRequest,
  RunSimulationResponse,
} from "../../dtos/simulation-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class RunSimulationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("SimulationRepository")
    private simulation: ISimulationRepository,
    @inject("RoutingProvider")
    private routingProvider: IRoutingProvider,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    data: RunSimulationRequest,
    userId: string,
  ): Promise<RunSimulationResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate permission (multi-tenancy)
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    // Check if there are routes
    if (!data.routes || data.routes.length === 0) {
      throw new AppError(
        "É necessário fornecer ao menos uma rota para simular!",
        400,
      );
    }

    // Create a simulation record with "pending" status.
    const simulation = await this.simulation.create({
      name: data.name,
      description: data.description,
      businessId: data.businessId,
      routes: data.routes,
      metadata: data.metadata,
    });

    // DECISION: Synchronous or Asynchronous?
    if (data.routes.length <= 5) {
      // ✅ SYNCHRONOUS: process directly (< 2s)
      console.log(
        `[RunSimulationUseCase] Processing ${data.routes.length} routes synchronously`,
      );

      try {
        const results = [];

        for (let i = 0; i < data.routes.length; i++) {
          const route = data.routes[i];

          // Build coordinates array
          const coordinates = [route.origin];
          if (route.waypoints && route.waypoints.length > 0) {
            coordinates.push(...route.waypoints);
          }

          coordinates.push(route.destination);

          // Calculate route using OSRM
          const routeResult = await this.routingProvider.calculateRoute({
            coordinates,
            alternatives: false,
            steps: false,
          });

          results.push({
            ...routeResult,
            origin: route.origin,
            destination: route.destination,
            waypoints: route.waypoints || [],
            vehicleId: route.vehicleId,
            driverId: route.driverId,
            name: route.name || `Rota ${i + 1}`,
          });
        }

        // Calculate totals
        const totalDistance = results.reduce((sum, r) => sum + r.distance, 0);
        const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

        const totalCost = results.reduce(
          (sum, r) => sum + (r.estimatedCost || 0),
          0,
        );

        // Update simulation with results
        await this.simulation.updateResults(simulation.id, {
          routes: results,
          totalDistance,
          totalDuration,
          totalCost,
          completedAt: new Date().toISOString(),
        });

        await this.simulation.updateStatus(simulation.id, "completed");

        // Create activity log
        this.notificationService.createActivityIfEnabled({
          type: "Simulação",
          action: "create",
          entityId: simulation.id,
          description: `Simulação concluída | ${data.routes.length} rotas | ${totalDistance}m`,
          status: "completed",
          performedBy: userId,
          businessId: data.businessId,
        });

        const updatedSimulation = await this.simulation.findById(simulation.id);

        // Send WebSocket notification: simulation completed (sync mode)
        sendNotificationToUser(userId, {
          type: "simulation_completed",
          businessId: data.businessId,
          data: {
            simulationId: simulation.id,
            status: "completed",
            totalDistance,
            totalDuration,
            totalCost,
            routesCount: data.routes.length,
          },
        });

        return {
          simulation: updatedSimulation!,
          status: "completed",
        };
      } catch (error) {
        console.error(
          "[RunSimulationUseCase] Error processing simulation:",
          error,
        );
        await this.simulation.updateStatus(simulation.id, "failed");

        // Send WebSocket notification: simulation failed (sync mode)
        sendNotificationToUser(userId, {
          type: "simulation_failed",
          businessId: data.businessId,
          data: {
            simulationId: simulation.id,
            status: "failed",
            error: error instanceof Error ? error.message : "Erro desconhecido",
          },
        });

        throw new AppError("Erro ao processar simulação!", 500);
      }
    } else {
      // ✅ ASYNCHRONOUS: queue job (worker + RabbitMQ)
      console.log(
        `[RunSimulationUseCase] Enqueueing ${data.routes.length} routes for async processing`,
      );

      try {
        const fleetCommandWorker = FleetCommandWorkerService.getInstance();

        await fleetCommandWorker.enqueueJob({
          jobType: "simulation",
          businessId: data.businessId,
          userId,
          data: {
            simulationId: simulation.id,
            routes: data.routes,
          },
        });

        // Create activity log
        this.notificationService.createActivityIfEnabled({
          type: "Simulação",
          action: "create",
          entityId: simulation.id,
          description: `Simulação enfileirada | ${data.routes.length} rotas`,
          status: "processing",
          performedBy: userId,
          businessId: data.businessId,
        });

        return {
          simulation,
          status: "processing",
          message:
            "Simulação enfileirada para processamento. Você será notificado quando concluir.",
        };
      } catch (error) {
        console.error("[RunSimulationUseCase] Error enqueueing job:", error);
        await this.simulation.updateStatus(simulation.id, "failed");
        throw new AppError("Erro ao enfileirar simulação!", 500);
      }
    }
  }
}

export { RunSimulationUseCase };
