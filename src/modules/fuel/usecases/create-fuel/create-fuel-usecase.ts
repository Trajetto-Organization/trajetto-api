import { inject, injectable } from "tsyringe";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleMileageInvalidError } from "../errors/vehicle-mileage-invalid-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

import { VehicleInvalidStatusForFuelError } from "../errors/vehicle-invalid-status-for-fuel-error";

import { AppError } from "@/shared/errors/AppError";
import { Fuel, CreateFuelProps } from "../../dtos/fuel-dto";

import { UploadService } from "@/shared/services/upload-service";
import { MultipartFile } from "@fastify/multipart";

import { calculateDistance } from "@/shared/utils/geolocation";

@injectable()
class CreateFuelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    fuelData: CreateFuelProps,
    userId: string,
    odometerPhotoFile: MultipartFile,
  ): Promise<Fuel> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(
      fuelData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate vehicle exists and belongs to business
    const findVehicle = await this.vehicle.findVehicleById(fuelData.vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== fuelData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // Security: If user is a driver, verify vehicle belongs to them
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      if (findVehicle.driverId !== findUser.driverId) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    // Auto-populate branchId, driverId, and fuelTypeId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        fuelData.driverId = findUser.driverId;

        // Force fuelTypeId to match vehicle's fuel type (drivers cannot change it)
        fuelData.fuelTypeId = findVehicle.fuelTypeId;

        // Force branchId - drivers cannot select branch manually
        // Priority: Vehicle.branchId → Driver.branchId
        fuelData.branchId =
          findVehicle.branchId || driverUser.branchId || undefined;
      }
    }

    // Validate vehicle status (only ACTIVE or IN_ROUTE vehicles can be fueled)
    if (findVehicle.status !== "ACTIVE" && findVehicle.status !== "IN_ROUTE") {
      throw new VehicleInvalidStatusForFuelError();
    }

    // Validate mileage (must be strictly greater than current vehicle mileage)
    if (fuelData.current_mileage <= findVehicle.current_mileage) {
      throw new VehicleMileageInvalidError();
    }

    // Validate driver exists and belongs to business (if driverId is provided)
    if (fuelData.driverId) {
      const findDriver = await this.driver.findDriverById(fuelData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== fuelData.businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    // Validate fuel type exists and belongs to business
    const findFuelType = await this.fuelType.findFuelTypeById(
      fuelData.fuelTypeId,
    );
    if (!findFuelType) {
      throw new FuelTypeNotFoundError();
    }

    if (findFuelType.businessId !== fuelData.businessId) {
      throw new FuelTypeNotBelongBusinessError();
    }

    // Validate branch exists and belongs to business (if branchId is provided)
    if (fuelData.branchId) {
      const findBranch = await this.branch.findBranchById(fuelData.branchId);
      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== fuelData.businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    // 🆕 GEOLOCATION LOGIC: Validate and process location data
    if (fuelData.created_from === "MOBILE_APP") {
      // Mobile: Location is REQUIRED
      if (!fuelData.latitude || !fuelData.longitude) {
        throw new AppError(
          "Para registros via aplicativo mobile, a localização é obrigatória.",
          400,
        );
      }

      // 🆕 VALIDATE DISTANCE IF GPS_MANUAL (manual adjustment)
      if (fuelData.location_source === "GPS_MANUAL") {
        // Verifica se temos a localização original
        if (!fuelData.latitude_original || !fuelData.longitude_original) {
          throw new AppError(
            "Localização original não fornecida para validação de ajuste.",
            400,
          );
        }

        // Calcula e valida a distância
        const distance = calculateDistance(
          fuelData.latitude_original,
          fuelData.longitude_original,
          fuelData.latitude,
          fuelData.longitude,
        );

        if (distance > 500) {
          throw new AppError(
            `A localização editada está ${Math.round(distance)}m distante da capturada pelo GPS. Máximo permitido: 500m. Possível inconsistência detectada.`,
            400,
          );
        }

        // Log de auditoria (opcional)
        console.log(
          `[AUDIT] GPS ajustado por ${userId} no fuel: ${Math.round(distance)}m de distância`,
        );
      } else if (!fuelData.location_source) {
        // Se não tem source, é GPS automático
        fuelData.location_source = "GPS_AUTO";

        // Copia localização final para original (não foi editada)
        fuelData.latitude_original = fuelData.latitude;
        fuelData.longitude_original = fuelData.longitude;
      }
    } else if (fuelData.created_from === "WEB_DASHBOARD") {
      // Web: Location is OPTIONAL
      if (fuelData.latitude && fuelData.longitude) {
        fuelData.location_source = "USER_MANUAL";
      } else {
        fuelData.location_source = "NONE";
      }
    }

    try {
      // Upload odometer photo
      const buffer = await odometerPhotoFile.toBuffer();
      const uploadResult = await this.uploadService.uploadFile({
        buffer,
        filename: odometerPhotoFile.filename || "odometer-photo",
        mimetype: odometerPhotoFile.mimetype,
        uploadType: "odometerPhotos",
      });

      // Prepare fuel data with photo and geolocation audit fields
      const fuelDataWithPhoto: any = {
        ...fuelData,
        odometer_photo: uploadResult.path,
      };

      // Add audit fields for web dashboard manual location
      if (
        fuelData.created_from === "WEB_DASHBOARD" &&
        fuelData.latitude &&
        fuelData.longitude
      ) {
        fuelDataWithPhoto.location_edited_by = userId;
        fuelDataWithPhoto.location_edited_at = new Date();
      }

      // Create fuel record
      const fuelCreated = await this.fuel.createFuel(fuelDataWithPhoto);

      // Update vehicle mileage to the current_mileage from fuel record
      await this.vehicle.updateVehicle({
        vehicleId: fuelData.vehicleId,
        vehicleData: {
          current_mileage: fuelData.current_mileage,
        },
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Abastecimento",
        action: "create",
        entityId: fuelCreated.id,
        description: `Abastecimento criado para o veículo ${findVehicle.license_plate} - ${findVehicle.description}`,
        status: "Criado",
        performedBy: userId,
        businessId: fuelData.businessId,
      });

      return fuelCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateFuelUseCase };
