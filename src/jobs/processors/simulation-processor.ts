import { FleetCommandJobData } from "../fleet-command-queue";

import { SimulationRepository } from "@/modules/simulation/repositories/simulation-repository";
import { OSRMProvider } from "@/shared/providers/routing-provider/implementations/osrm-provider";

import { sendNotificationToUser } from "@/websocket";

class SimulationProcessor {
  private simulationRepo: SimulationRepository;
  private routingProvider: OSRMProvider;

  constructor() {
    this.simulationRepo = new SimulationRepository();
    this.routingProvider = new OSRMProvider();
  }

  async process(jobData: FleetCommandJobData): Promise<void> {
    const { businessId, userId, data } = jobData;
    const { simulationId, routes } = data;

    try {
      // Update status to "processing"
      await this.simulationRepo.updateStatus(simulationId, "processing");

      console.log(
        `[SimulationProcessor] Processing simulation ${simulationId} for business ${businessId} with ${routes.length} routes`,
      );

      // Send WebSocket notification: processing started
      sendNotificationToUser(userId as string, {
        type: "simulation_processing",
        businessId,
        data: {
          simulationId,
          status: "processing",
          totalRoutes: routes.length,
        },
      });

      // Process routes
      const results = [];
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];

        // Build coordinates array for OSRM
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

        // Log progress and send WebSocket update
        const progress = Math.round(((i + 1) / routes.length) * 100);
        console.log(
          `[SimulationProcessor] Progress: ${progress}% (${i + 1}/${routes.length})`,
        );

        // Send WebSocket notification: progress update
        sendNotificationToUser(userId as string, {
          type: "simulation_progress",
          businessId,
          data: {
            simulationId,
            progress,
            currentRoute: i + 1,
            totalRoutes: routes.length,
          },
        });
      }

      // Calculate totals
      const totalDistance = results.reduce((sum, r) => sum + r.distance, 0);
      const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

      const totalCost = results.reduce(
        (sum, r) => sum + (r.estimatedCost || 0),
        0,
      );

      // Save results
      await this.simulationRepo.updateResults(simulationId, {
        routes: results,
        totalDistance,
        totalDuration,
        totalCost,
        completedAt: new Date().toISOString(),
      });

      // Update status to "completed"
      await this.simulationRepo.updateStatus(simulationId, "completed");

      console.log(
        `[SimulationProcessor] Simulation ${simulationId} for business ${businessId} completed successfully`,
      );

      // Send WebSocket notification: simulation completed
      sendNotificationToUser(userId as string, {
        type: "simulation_completed",
        businessId,
        data: {
          simulationId,
          status: "completed",
          totalDistance,
          totalDuration,
          totalCost,
          routesCount: routes.length,
        },
      });
    } catch (error) {
      console.error(
        `[SimulationProcessor] Error processing simulation ${simulationId} for business ${businessId}:`,
        error,
      );

      try {
        await this.simulationRepo.updateStatus(simulationId, "failed");

        // Send WebSocket notification: simulation failed
        sendNotificationToUser(userId as string, {
          type: "simulation_failed",
          businessId,
          data: {
            simulationId,
            status: "failed",
            error: error instanceof Error ? error.message : "Erro desconhecido",
          },
        });
      } catch (updateError) {
        console.error(
          `[SimulationProcessor] Error updating status to failed:`,
          updateError,
        );
      }

      throw error;
    }
  }
}

export { SimulationProcessor };
