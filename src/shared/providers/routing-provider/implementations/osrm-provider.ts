import { IRoutingProvider } from "../IRouting-provider";

import {
  RouteResult,
  OptimizedRouteResult,
} from "@/modules/routing/dtos/route-dto";
import { env } from "@/env";

class OSRMProvider implements IRoutingProvider {
  private baseURL = env.OSRM_URL || "http://localhost:5000";

  async calculateRoute(params: {
    coordinates: Array<{ lat: number; lng: number }>;
    alternatives?: boolean;
    steps?: boolean;
  }): Promise<RouteResult> {
    try {
      // Format coordinates: lng,lat;lng,lat
      const coords = params.coordinates
        .map((c) => `${c.lng},${c.lat}`)
        .join(";");

      // Assemble URL
      const url = `${this.baseURL}/route/v1/driving/${coords}`;
      const queryParams = new URLSearchParams();

      if (params.alternatives) queryParams.append("alternatives", "true");

      if (params.steps) queryParams.append("steps", "true");
      queryParams.append("overview", "full");
      queryParams.append("geometries", "geojson");

      const fullUrl = `${url}?${queryParams.toString()}`;

      // Make request
      const response = await fetch(fullUrl);
      const data = await response.json();

      if (data.code !== "Ok") {
        throw new Error(`OSRM error: ${data.message || "Unknown error"}`);
      }

      const route = data.routes[0];

      // Calculate estimated cost (R$ 0.80/km base)
      const distanceKm = route.distance / 1000;
      const estimatedCost = distanceKm * 0.8;

      // Format duration
      const hours = Math.floor(route.duration / 3600);

      const minutes = Math.floor((route.duration % 3600) / 60);
      const durationFormatted =
        hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;

      // Process steps if requested.
      let steps = undefined;
      if (params.steps && route.legs) {
        steps = route.legs.flatMap((leg: any) =>
          leg.steps.map((step: any) => ({
            distance: step.distance,
            duration: step.duration,
            instruction: step.maneuver?.type || "continue",
          })),
        );
      }

      return {
        distance: route.distance,
        duration: route.duration,
        distanceKm,
        durationFormatted,
        estimatedCost,
        geometry: route.geometry,
        steps,
      };
    } catch (error) {
      console.error("[OSRM Provider] Calculate route error:", error);
      throw new Error(
        "Erro ao calcular rota. Verifique se o serviço OSRM está rodando.",
      );
    }
  }

  async optimizeRoute(params: {
    coordinates: Array<{ lat: number; lng: number }>;
    roundtrip?: boolean;
    source?: "first" | "any";
    destination?: "last" | "any";
  }): Promise<OptimizedRouteResult> {
    try {
      const coords = params.coordinates
        .map((c) => `${c.lng},${c.lat}`)
        .join(";");

      const url = `${this.baseURL}/trip/v1/driving/${coords}`;
      const queryParams = new URLSearchParams();

      if (params.roundtrip !== undefined) {
        queryParams.append("roundtrip", params.roundtrip.toString());
      }

      if (params.source) queryParams.append("source", params.source);

      if (params.destination)
        queryParams.append("destination", params.destination);
      queryParams.append("overview", "full");
      queryParams.append("geometries", "geojson");

      const fullUrl = `${url}?${queryParams.toString()}`;

      const response = await fetch(fullUrl);
      const data = await response.json();

      if (data.code !== "Ok") {
        throw new Error(`OSRM error: ${data.message || "Unknown error"}`);
      }

      const trip = data.trips[0];

      const distanceKm = trip.distance / 1000;
      const estimatedCost = distanceKm * 0.8;

      const hours = Math.floor(trip.duration / 3600);
      const minutes = Math.floor((trip.duration % 3600) / 60);

      const durationFormatted =
        hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;

      return {
        distance: trip.distance,
        duration: trip.duration,
        distanceKm,
        durationFormatted,
        estimatedCost,
        geometry: trip.geometry,
        waypointsOrder: data.waypoints.map((wp: any) => wp.waypoint_index),
      };
    } catch (error) {
      console.error("[OSRM Provider] Optimize route error:", error);
      throw new Error("Erro ao otimizar rota.");
    }
  }

  async calculateMatrix(params: {
    coordinates: Array<{ lat: number; lng: number }>;
  }): Promise<number[][]> {
    try {
      const coords = params.coordinates
        .map((c) => `${c.lng},${c.lat}`)
        .join(";");

      const url = `${this.baseURL}/table/v1/driving/${coords}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.code !== "Ok") {
        throw new Error(`OSRM error: ${data.message || "Unknown error"}`);
      }

      return data.durations; // duration matrix
    } catch (error) {
      console.error("[OSRM Provider] Calculate matrix error:", error);
      throw new Error("Erro ao calcular matriz de distâncias.");
    }
  }
}

export { OSRMProvider };
