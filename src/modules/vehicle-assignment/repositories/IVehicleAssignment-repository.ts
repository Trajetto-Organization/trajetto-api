import {
  VehicleAssignment,
  CreateVehicleAssignmentProps,
  UpdateVehicleAssignmentProps,
  ListVehicleAssignmentsProps,
  ListVehicleAssignmentsResult,
} from "../dtos/vehicle-assignment-dto";

interface IVehicleAssignmentRepository {
  createAssignment: (
    data: CreateVehicleAssignmentProps,
  ) => Promise<VehicleAssignment>;
  listAssignments: (
    props: ListVehicleAssignmentsProps,
  ) => Promise<ListVehicleAssignmentsResult>;
  findAssignmentById: (id: string) => Promise<VehicleAssignment | null>;
  findAssignmentByBusinessAndId: (
    assignmentId: string,
    businessId: string,
  ) => Promise<VehicleAssignment | null>;
  updateAssignment: (
    props: UpdateVehicleAssignmentProps,
  ) => Promise<VehicleAssignment>;
  deleteAssignment: (id: string) => Promise<VehicleAssignment>;
  findAssignmentsByRoute: (routeId: string) => Promise<VehicleAssignment[]>;
  findAssignmentsByVehicle: (vehicleId: string) => Promise<VehicleAssignment[]>;
  findAssignmentsByDriver: (driverId: string) => Promise<VehicleAssignment[]>;
  findByVehicleAndDate: (
    vehicleId: string,
    scheduledDate: Date,
  ) => Promise<VehicleAssignment | null>;
  countAssignmentsByBusiness: (businessId: string) => Promise<number>;
}

export { IVehicleAssignmentRepository };
