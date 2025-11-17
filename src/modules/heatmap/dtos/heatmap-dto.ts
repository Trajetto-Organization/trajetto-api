// Types of heatmaps available
type HeatmapType = "fines" | "fuel" | "maintenance";

// Request to generate heatmap
interface GenerateHeatmapProps {
  businessId: string;
  heatmapType: HeatmapType;
  startDate: Date;
  endDate: Date;
  vehicleId?: string; // Optional filter per vehicle
  filters?: HeatmapFilters;
}

// Specific filters by type
interface HeatmapFilters {
  fineType?: string; // For fines heatmap
  fuelType?: string; // For fuel heatmap
  maintenanceType?: "INTERNAL" | "EXTERNAL"; // For maintenance heatmap
}

// Individual point on the heatmap
interface HeatmapPoint {
  lat: number; // Latitude
  lng: number; // Longitude
  intensity: number; // 0.0 - 1.0 (normalized weight for display)
  value: number; // Actual value (R$ or liters)
  count: number; // Number of occurrences at this point
  metadata?: Record<string, any>; // Additional information (vehicle, type, etc.)
}

// Heatmap statistics
interface HeatmapStatistics {
  totalValue: number; // Total in R$ or liters
  totalCount: number; // Total occurrences
  maxIntensity: number; // Maximum intensity (for normalization)
  averageValue: number; // Average value per point
}

// Heatmap period
interface HeatmapPeriod {
  startDate: Date;
  endDate: Date;
}

// Full heatmap result
interface HeatmapResults {
  type: HeatmapType;
  period: HeatmapPeriod;
  points: HeatmapPoint[]; // Array of points to render
  statistics: HeatmapStatistics;
  filters?: HeatmapFilters;
  insights?: string[]; // Automatically generated insights
  generated_at: Date;
}

// Raw fine data with location.
interface FineWithLocation {
  id: string;
  lat: number;
  lng: number;
  amount: number;
  violationType: string;
  vehicleId: string;
  licensePlate: string;
  date: Date;
}

// Raw fuel data with location.
interface FuelWithLocation {
  id: string;
  lat: number;
  lng: number;
  liters: number;
  cost: number;
  fuelType: string;
  vehicleId: string;
  licensePlate: string;
  date: Date;
}

// Raw maintenance data with location.
interface ServiceOrderWithLocation {
  id: string;
  lat: number;
  lng: number;
  cost: number;
  maintenanceType: string;
  vehicleId: string;
  licensePlate: string;
  date: Date;
}

export {
  HeatmapType,
  GenerateHeatmapProps,
  HeatmapFilters,
  HeatmapPoint,
  HeatmapStatistics,
  HeatmapPeriod,
  HeatmapResults,
  FineWithLocation,
  FuelWithLocation,
  ServiceOrderWithLocation,
};
