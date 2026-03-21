import { inject, injectable } from "tsyringe";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { AppError } from "@/shared/errors/AppError";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
} from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";
import { MultipartFile } from "@fastify/multipart";

import AIVerificationWorkerService from "@/shared/services/ai-verification-worker-service";

@injectable()
class CreateVehicleChecklistUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    checklistData: CreateVehicleChecklistProps,
    userId: string,
    checklistPhotoFiles?: MultipartFile[],
    photoFieldMapping?: Record<string, string[]>,
  ): Promise<VehicleChecklist> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(
      checklistData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate vehicle exists and belongs to business
    const findVehicle = await this.vehicle.findVehicleById(
      checklistData.vehicleId,
    );

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== checklistData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // Security: If user is a driver, verify vehicle belongs to them
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      if (findVehicle.driverId !== findUser.driverId) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    // Auto-populate branchId and driverId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        checklistData.driverId = findUser.driverId;

        // Force branchId - drivers cannot select branch manually
        // Priority: Vehicle.branchId → Driver.branchId
        checklistData.branchId =
          findVehicle.branchId || driverUser.branchId || undefined;
      }
    }

    // Validate mileage (cannot be less than current vehicle mileage)
    if (checklistData.current_mileage <= findVehicle.current_mileage) {
      throw new VehicleMileageInvalidError();
    }

    // Validate driver exists and belongs to business (if driverId is provided)
    if (checklistData.driverId) {
      const findDriver = await this.driver.findDriverById(
        checklistData.driverId,
      );

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== checklistData.businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    // Validate branch exists and belongs to business (if branchId is provided)
    if (checklistData.branchId) {
      const findBranch = await this.branch.findBranchById(
        checklistData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== checklistData.businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    try {
      // Upload checklist photos if provided
      let photoPaths: string[] = [];
      const photoPathsByField: Record<string, string[]> = {};

      if (checklistPhotoFiles && checklistPhotoFiles.length > 0) {
        for (const photoFile of checklistPhotoFiles) {
          const buffer = await photoFile.toBuffer();
          const uploadResult = await this.uploadService.uploadFile({
            buffer,
            filename: photoFile.filename || "checklist-photo",
            mimetype: photoFile.mimetype,
            uploadType: "checklistPhotos",
          });

          photoPaths.push(uploadResult.path);

          // Build field-to-path mapping from the original field name
          if (photoFieldMapping) {
            for (const [fieldName, originalFilenames] of Object.entries(
              photoFieldMapping,
            )) {
              if (
                originalFilenames.includes(
                  photoFile.filename || "checklist-photo",
                )
              ) {
                if (!photoPathsByField[fieldName]) {
                  photoPathsByField[fieldName] = [];
                }

                photoPathsByField[fieldName].push(uploadResult.path);
              }
            }
          }
        }
      }

      // Add photo paths to checklist data
      const checklistDataWithPhotos = {
        ...checklistData,
        photos: photoPaths,
        photos_by_field:
          Object.keys(photoPathsByField).length > 0
            ? photoPathsByField
            : undefined,
      };

      // Create checklist record
      const checklistCreated =
        await this.vehicleChecklist.createVehicleChecklist(
          checklistDataWithPhotos,
        );

      // Update vehicle mileage to the current_mileage from checklist record
      await this.vehicle.updateVehicle({
        vehicleId: checklistData.vehicleId,
        vehicleData: {
          current_mileage: checklistData.current_mileage,
        },
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Checklist Veicular",
        action: "create",
        entityId: checklistCreated.id,
        description: `Checklist veicular criado para o veículo ${findVehicle.license_plate} - ${findVehicle.description}`,
        status: "Criado",
        performedBy: userId,
        businessId: checklistData.businessId,
      });

      // Enqueue AI verification for checklist photos (fire-and-forget)
      // Skip if business has AI disabled (limit === 0)
      if (
        (findBusiness.ai_analysis_limit ?? 0) > 0 &&
        Object.keys(photoPathsByField).length > 0
      ) {
        AIVerificationWorkerService.getInstance()
          .enqueueVerification({
            type: "checklist",
            recordId: checklistCreated.id,
            businessId: checklistData.businessId,
            userId,
            photosByField: photoPathsByField,
            checklistData: checklistData as Record<string, any>,
          })
          .catch((err) =>
            console.error(
              "[AI] Failed to enqueue checklist verification:",
              err,
            ),
          );
      }

      return checklistCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateVehicleChecklistUseCase };
