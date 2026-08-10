import { v7 as uuidV7 } from "uuid";
import { IVehicleChecklistRepository } from "../IVehicle-checklist-repository";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
} from "../../dtos/vehicle-checklist-dto";

class InMemoryVehicleChecklistRepository
  implements IVehicleChecklistRepository
{
  public checklists: VehicleChecklist[] = [];

  async createVehicleChecklist(
    checklistData: CreateVehicleChecklistProps,
  ): Promise<VehicleChecklist> {
    const checklist: VehicleChecklist = {
      id: uuidV7(),
      client_submission_id: checklistData.client_submission_id ?? null,
      current_mileage: checklistData.current_mileage,
      checklist_date: checklistData.checklist_date || new Date(),
      tires_condition: checklistData.tires_condition,
      headlights_working: checklistData.headlights_working,
      taillights_working: checklistData.taillights_working,
      turn_signals_working: checklistData.turn_signals_working,
      bumpers_condition: checklistData.bumpers_condition,
      windshield_condition: checklistData.windshield_condition,
      mirrors_condition: checklistData.mirrors_condition,
      seatbelts_working: checklistData.seatbelts_working,
      dashboard_working: checklistData.dashboard_working,
      steering_wheel_condition: checklistData.steering_wheel_condition,
      brakes_working: checklistData.brakes_working,
      clutch_working: checklistData.clutch_working,
      fuel_level_adequate: checklistData.fuel_level_adequate,
      oil_level_adequate: checklistData.oil_level_adequate,
      radiator_water_adequate: checklistData.radiator_water_adequate,
      brake_fluid_adequate: checklistData.brake_fluid_adequate,
      battery_condition: checklistData.battery_condition,
      driver_license_valid: checklistData.driver_license_valid,
      vehicle_documents_valid: checklistData.vehicle_documents_valid,
      insurance_valid: checklistData.insurance_valid,
      fire_extinguisher_valid: checklistData.fire_extinguisher_valid,
      warning_triangle_present: checklistData.warning_triangle_present,
      jack_present: checklistData.jack_present,
      spare_tire_condition: checklistData.spare_tire_condition,
      notes: checklistData.notes || null,
      photos: checklistData.photos || [],
      overall_condition: checklistData.overall_condition,
      businessId: checklistData.businessId,
      branchId: checklistData.branchId || "",
      vehicleId: checklistData.vehicleId,
      driverId: checklistData.driverId || "",
      ai_verification_status: "",
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.checklists.push(checklist);
    return checklist;
  }

  async findBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<VehicleChecklist | null> {
    return (
      this.checklists.find(
        (checklist) =>
          checklist.businessId === businessId &&
          checklist.client_submission_id === clientSubmissionId,
      ) ?? null
    );
  }

  async createVehicleChecklistWithMileage(
    checklistData: CreateVehicleChecklistProps,
  ): Promise<{ checklist: VehicleChecklist; created: boolean }> {
    if (checklistData.client_submission_id) {
      const existing = await this.findBySubmissionId(
        checklistData.businessId,
        checklistData.client_submission_id,
      );
      if (existing) return { checklist: existing, created: false };
    }

    return {
      checklist: await this.createVehicleChecklist(checklistData),
      created: true,
    };
  }

  async listVehicleChecklists({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
    vehicleId,
    driverId,
    overall_condition,
    startDate,
    endDate,
  }: ListVehicleChecklistByBusinessIdProps): Promise<ListVehicleChecklistProps> {
    let filteredChecklists =
      currentUserRole === "MASTER"
        ? [...this.checklists]
        : this.checklists.filter(
            (checklist) => checklist.businessId === businessId,
          );

    if (search) {
      const searchLower = search.toLowerCase();
      filteredChecklists = filteredChecklists.filter(
        (checklist) =>
          checklist.notes?.toLowerCase().includes(searchLower) ||
          checklist.overall_condition.toLowerCase().includes(searchLower),
      );
    }

    if (vehicleId) {
      filteredChecklists = filteredChecklists.filter(
        (checklist) => checklist.vehicleId === vehicleId,
      );
    }

    if (driverId) {
      filteredChecklists = filteredChecklists.filter(
        (checklist) => checklist.driverId === driverId,
      );
    }

    if (overall_condition) {
      filteredChecklists = filteredChecklists.filter(
        (checklist) => checklist.overall_condition === overall_condition,
      );
    }

    if (startDate) {
      filteredChecklists = filteredChecklists.filter(
        (checklist) =>
          new Date(checklist.checklist_date) >= new Date(startDate),
      );
    }

    if (endDate) {
      filteredChecklists = filteredChecklists.filter(
        (checklist) => new Date(checklist.checklist_date) <= new Date(endDate),
      );
    }

    const total = filteredChecklists.length;
    const skip = (page - 1) * pageSize;

    const paginatedChecklists = filteredChecklists.slice(skip, skip + pageSize);

    return {
      data: paginatedChecklists,
      total,
    };
  }

  async updateVehicleChecklist({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist): Promise<VehicleChecklist> {
    const index = this.checklists.findIndex(
      (checklist) => checklist.id === checklistId,
    );

    if (index === -1) {
      throw new Error("Checklist not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(checklistData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updatedChecklist: VehicleChecklist = {
      ...this.checklists[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.checklists[index] = updatedChecklist;
    return updatedChecklist;
  }

  async updateVehicleChecklistAndMileage(
    update: UpdateVehicleChecklist,
  ): Promise<VehicleChecklist> {
    return this.updateVehicleChecklist(update);
  }

  async deleteVehicleChecklist(checklistId: string): Promise<VehicleChecklist> {
    const index = this.checklists.findIndex(
      (checklist) => checklist.id === checklistId,
    );

    if (index === -1) {
      throw new Error("Checklist not found");
    }

    const deletedChecklist = this.checklists.splice(index, 1)[0];
    return deletedChecklist;
  }

  async findVehicleChecklistById(
    checklistId: string,
  ): Promise<VehicleChecklist | null> {
    const found = this.checklists.find(
      (checklist) => checklist.id === checklistId,
    );

    return found || null;
  }

  async findVehicleChecklistByIdWithRelations(
    checklistId: string,
  ): Promise<VehicleChecklistWithRelations | null> {
    const found = this.checklists.find(
      (checklist) => checklist.id === checklistId,
    );

    if (!found) {
      return null;
    }

    // Mock relations for testing
    return {
      ...found,
      checklist_date: new Date(found.checklist_date).toISOString(),
      created_at: new Date(found.created_at).toISOString(),
      updated_at: new Date(found.updated_at).toISOString(),
      business: {
        id: found.businessId,
        corporate_reason: "Test Business",
        fantasy_name: "Test Business Fantasy",
      },
      branch: {
        id: found.branchId,
        corporate_reason: "Test Branch",
        fantasy_name: "Test Branch Fantasy",
      },
      vehicle: {
        id: found.vehicleId,
        description: "Test Vehicle",
        license_plate: "ABC-1234",
        brand: "Test Brand",
        model: "Test Model",
        current_mileage: found.current_mileage,
      },
      driver: {
        id: found.driverId,
        name: "Test Driver",
        cnh: "12345678901",
      },
    };
  }

  async getVehicleChecklistByIdAndBusiness({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklist | null> {
    const found = this.checklists.find(
      (checklist) =>
        checklist.id === checklistId && checklist.businessId === businessId,
    );

    return found || null;
  }

  async getVehicleChecklistByIdAndBusinessWithRelations({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklistWithRelations | null> {
    const found = this.checklists.find(
      (checklist) =>
        checklist.id === checklistId && checklist.businessId === businessId,
    );

    if (!found) {
      return null;
    }

    // Mock relations for testing
    return {
      ...found,
      checklist_date: new Date(found.checklist_date).toISOString(),
      created_at: new Date(found.created_at).toISOString(),
      updated_at: new Date(found.updated_at).toISOString(),
      business: {
        id: found.businessId,
        corporate_reason: "Test Business",
        fantasy_name: "Test Business Fantasy",
      },
      branch: {
        id: found.branchId,
        corporate_reason: "Test Branch",
        fantasy_name: "Test Branch Fantasy",
      },
      vehicle: {
        id: found.vehicleId,
        description: "Test Vehicle",
        license_plate: "ABC-1234",
        brand: "Test Brand",
        model: "Test Model",
        current_mileage: found.current_mileage,
      },
      driver: {
        id: found.driverId,
        name: "Test Driver",
        cnh: "12345678901",
      },
    };
  }

  async findVehicleChecklistsByVehicleId(
    vehicleId: string,
  ): Promise<VehicleChecklist[]> {
    return this.checklists.filter(
      (checklist) => checklist.vehicleId === vehicleId,
    );
  }

  async findVehicleChecklistsByDriverId(
    driverId: string,
  ): Promise<VehicleChecklist[]> {
    return this.checklists.filter(
      (checklist) => checklist.driverId === driverId,
    );
  }

  async *streamChecklistsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    let filtered =
      userRole === "MASTER"
        ? [...this.checklists]
        : this.checklists.filter(
            (checklist) => checklist.businessId === businessId,
          );

    if (search) {
      const searchTerm = search.toLowerCase();
      filtered = filtered.filter(
        (checklist) =>
          checklist.id.toLowerCase().includes(searchTerm) ||
          checklist.notes?.toLowerCase().includes(searchTerm) ||
          checklist.overall_condition.toLowerCase().includes(searchTerm),
      );
    }

    for (const checklist of filtered) {
      yield {
        id: checklist.id,
        vehicleLicensePlate: null,
        vehicleDescription: null,
        vehicleBrand: null,
        vehicleModel: null,
        vehicleCurrentMileage: null,
        driverName: null,
        driverCnh: null,
        checklist_date: checklist.checklist_date,
        current_mileage: checklist.current_mileage,
        tires_condition: checklist.tires_condition,
        headlights_working: checklist.headlights_working,
        taillights_working: checklist.taillights_working,
        turn_signals_working: checklist.turn_signals_working,
        bumpers_condition: checklist.bumpers_condition,
        windshield_condition: checklist.windshield_condition,
        mirrors_condition: checklist.mirrors_condition,
        seatbelts_working: checklist.seatbelts_working,
        dashboard_working: checklist.dashboard_working,
        steering_wheel_condition: checklist.steering_wheel_condition,
        brakes_working: checklist.brakes_working,
        clutch_working: checklist.clutch_working,
        fuel_level_adequate: checklist.fuel_level_adequate,
        oil_level_adequate: checklist.oil_level_adequate,
        radiator_water_adequate: checklist.radiator_water_adequate,
        brake_fluid_adequate: checklist.brake_fluid_adequate,
        battery_condition: checklist.battery_condition,
        driver_license_valid: checklist.driver_license_valid,
        vehicle_documents_valid: checklist.vehicle_documents_valid,
        insurance_valid: checklist.insurance_valid,
        fire_extinguisher_valid: checklist.fire_extinguisher_valid,
        warning_triangle_present: checklist.warning_triangle_present,
        jack_present: checklist.jack_present,
        spare_tire_condition: checklist.spare_tire_condition,
        overall_condition: checklist.overall_condition,
        notes: checklist.notes,
        branchName: null,
        ...(userRole === "MASTER" ? { businessName: null } : {}),
        created_at: checklist.created_at,
        updated_at: checklist.updated_at,
      };
    }
  }

  async countChecklistForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const filteredChecklists =
      userRole === "MASTER"
        ? this.checklists
        : this.checklists.filter(
            (checklist) => checklist.businessId === businessId,
          );

    return filteredChecklists.length;
  }
}

export { InMemoryVehicleChecklistRepository };
