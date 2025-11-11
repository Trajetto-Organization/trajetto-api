import { Coordinate } from "@/modules/routing/dtos/route-dto";

interface VehicleAssignment {
  id: string;
  routeId: string;
  vehicleId: string;
  driverId: string | null;
  scheduledDate: Date;
  status: string; // pending, in_progress, completed, cancelled
  notes: string | null;
  businessId: string;
  created_at: Date;
  updated_at: Date;
  // Optional relationships
  route?: {
    id: string;
    name?: string | null;
    origin: Coordinate;
    destination: Coordinate;
    distance: number;
    duration: number;
    estimatedCost: number;
  };
  vehicle?: {
    id: string;
    description: string;
    license_plate: string;
    brand: string;
    model: string;
    status: string;
  };
  driver?: {
    id: string;
    name: string;
    cpf: string;
  } | null;
}

interface CreateVehicleAssignmentProps {
  routeId: string;
  vehicleId: string;
  driverId?: string;
  scheduledDate: Date | string;
  status?: string;
  notes?: string;
  businessId: string;
}

interface UpdateVehicleAssignmentProps {
  id: string;
  vehicleId?: string;
  driverId?: string | null;
  scheduledDate?: Date | string;
  status?: string;
  notes?: string | null;
}

interface ListVehicleAssignmentsProps {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  vehicleId?: string;
  driverId?: string;
  businessId: string;
}

interface ListVehicleAssignmentsResult {
  data: VehicleAssignment[];
  total: number;
}

export {
  VehicleAssignment,
  CreateVehicleAssignmentProps,
  UpdateVehicleAssignmentProps,
  ListVehicleAssignmentsProps,
  ListVehicleAssignmentsResult,
};
