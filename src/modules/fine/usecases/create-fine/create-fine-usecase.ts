import { inject, injectable } from "tsyringe";

import { IFineRepository } from "../../repositories/IFine-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { Fine, CreateFineProps } from "../../dtos/fine-dto";
import { User } from "@/modules/user/dtos/user-dto";

import { Driver } from "@/modules/driver/dtos/driver-dto";
import { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

import { Branch } from "@/modules/branch/dtos/branch-dto";
import { TrafficViolationCode } from "../../dtos/traffic-violation-code-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { FineDateInfractionCannotBeFutureError } from "../errors/fine-date-infraction-cannot-be-future-error";
import { FineDueDateMustBeAfterInfractionError } from "../errors/fine-due-date-must-be-after-infraction-error";

import { formatCurrency, formatDate } from "@/shared/utils/format-values";
import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";

import { FinePaymentDateCannotBeEarlierInfractionError } from "../errors/fine-payment-date-cannot-be-earlier-infraction-error";
import { FineRegistrationsMobileLocationRequiredError } from "../errors/fine-registrations-mobile-location-required-error";

import { FineLocationNotProvidedAdjustmentValidationError } from "../errors/fine-location-not-provided-adjustment-validation-error";

import { NotificationService } from "@/shared/services/notification-service";
import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

interface FineNotificationsTextProps {
  userName?: string;
  fineAmount: string;
  vehiclePlate: string;
  violationDate: string;
  location?: string;
  observation?: string;
  points?: number;
  branchName: string;
  email?: string;
  fineId: string;
}

interface ProcessNotificationsParams {
  fineCreated: Fine;
  findUser: User;
  findDriver: Driver;
  findVehicle: Vehicle;
  findBranch: Branch;
  findTrafficViolationCode: TrafficViolationCode;
  businessId: string;
  userId: string;
}

@injectable()
class CreateFineUseCase {
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
    @inject("TrafficViolationCodeRepository")
    private trafficViolationCode: ITrafficViolationCodeRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  private buildFineNotificationText({
    branchName,
    email,
    fineAmount,
    userName,
    vehiclePlate,
    violationDate,
    location,
    observation,
    points,
    fineId,
  }: FineNotificationsTextProps): string {
    const locationPart = location ? `\nLocal: ${location}` : "";

    return [
      `🚨 *Nova Multa Registrada!*`,
      userName && `Usuário: *${userName}*`,
      email && `E-mail: *${email}*`,
      `Filial: *${branchName}*`,
      `Veículo: *${vehiclePlate}*`,
      `Valor: *${fineAmount}*`,
      `Identificador da multa: *${fineId}*`,
      `Data da infração: *${violationDate}*${locationPart}`,
      points && `Pontos na carteira: *${points}`,
      observation && `Observação: *${observation}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async processNotifications({
    fineCreated,
    findUser,
    findDriver,
    findVehicle,
    findBranch,
    findTrafficViolationCode,
    userId,
    businessId,
  }: ProcessNotificationsParams): Promise<void> {
    try {
      // Create activity for the user who created the fine
      const activityData = {
        type: "Multa",
        action: "create",
        entityId: fineCreated.id,
        description: `Multa registrada para o motorista ${findDriver.name} 
        no valor de ${formatCurrency(Number(fineCreated.amount))} | 
        Infração: ${findTrafficViolationCode.code}-${findTrafficViolationCode.sub_code} | 
        Veículo: ${findVehicle.license_plate} | 
        Pontos: ${fineCreated.points} | 
        ID: ${fineCreated.id}`,
        status: "Pendente",
        performedBy: userId,
        businessId: businessId,
      };

      // Get notification recipients based on user role
      let notificationRecipients: any[] = [];

      if (findUser.role === "MASTER") {
        notificationRecipients =
          await this.user.findBusinessAdminsByBusinessId(businessId);
      } else if (
        findUser.role === "BUSINESS_ADMIN" ||
        findUser.role === "BUSINESS_USER"
      ) {
        // BUSINESS_ADMIN/USER notificam apenas outros BUSINESS_ADMINs da mesma empresa
        notificationRecipients = await this.user.findBusinessAdminsByBusinessId(
          findUser.businessId as string,
        );
      }

      // Build WhatsApp message
      const whatsAppMessage = this.buildFineNotificationText({
        userName: findUser.role === "MASTER" ? undefined : findUser.name,
        email: findUser.role === "MASTER" ? undefined : findUser.email,
        fineAmount: formatCurrency(Number(fineCreated.amount)),
        vehiclePlate: findVehicle.license_plate,
        violationDate: formatDate(fineCreated.violation_date, "pt-BR"),
        location: fineCreated.location || undefined,
        branchName: findBranch.corporate_reason,
        observation: fineCreated.observation as string,
        points: fineCreated.points as number,
        fineId: fineCreated.id,
      });

      // Send notifications to each administrator (if any)
      if (notificationRecipients.length > 0) {
        const notificationPromises = notificationRecipients.map(
          async (admin) => {
            const instanceName = generateWhatsAppInstanceName(
              admin.email,
              businessId,
            );

            const notificationData = {
              userId: admin.id,
              type: "fine",
              title: "Nova Multa Registrada",
              message: `Nova multa de ${formatCurrency(Number(fineCreated.amount))} foi registrada para o veículo ${findVehicle.license_plate}`,
              entityId: fineCreated.id,
              link: `${this.http_request}/dashboard/fine?search=${fineCreated.id}&page=1`,
              businessId: businessId,
              shouldSendEmail: admin.email_notifications_enabled,
              shouldSendWhatsApp: admin.whatsapp_notifications_enabled,
              whatsAppMessage,
              instanceName,
            };

            await this.notificationService.processUserNotifications({
              notification: notificationData,
              activity: activityData,
            });
          },
        );

        // Wait for all notifications to process
        await Promise.allSettled(notificationPromises);
      } else {
        // Fallback: Create activity even if no recipients found
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error("[Fine] Erro ao processar notificações:", error);
      // Does not prevent the creation of the service order
    }
  }

  async execute(fineData: CreateFineProps, userId: string): Promise<Fine> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      fineData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findBranch = await this.branch.findBranchById(fineData.branchId);

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== fineData.businessId) {
      throw new BranchNotBelongBusinessError();
    }

    const findDriver = await this.driver.findDriverById(fineData.driverId);

    if (!findDriver) {
      throw new DriverNotFoundError();
    }

    if (findDriver.businessId !== fineData.businessId) {
      throw new DriverNotBelongBusinessError();
    }

    const findVehicle = await this.vehicle.findVehicleById(fineData.vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== fineData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    const findTrafficViolationCode =
      await this.trafficViolationCode.findTrafficViolationCodeById(
        fineData.trafficViolationCodeId,
      );

    if (!findTrafficViolationCode) {
      throw new TrafficViolationCodeNotFoundError();
    }

    const violationDate = new Date(fineData.violation_date);
    const dueDate = new Date(fineData.due_date);

    const today = new Date();

    if (violationDate > today) {
      throw new FineDateInfractionCannotBeFutureError();
    }

    if (dueDate <= violationDate) {
      throw new FineDueDateMustBeAfterInfractionError();
    }

    if (fineData.payment_date) {
      const paymentDate = new Date(fineData.payment_date);

      if (paymentDate < violationDate) {
        throw new FinePaymentDateCannotBeEarlierInfractionError();
      }
    }

    if (!fineData.points) {
      fineData.points = findTrafficViolationCode.points;
    }

    // 🆕 GEOLOCATION LOGIC: Validate and process location data
    if (fineData.created_from === "MOBILE_APP") {
      // Mobile: Location is REQUIRED
      if (!fineData.latitude || !fineData.longitude) {
        throw new FineRegistrationsMobileLocationRequiredError();
      }

      // 🆕 VALIDATE DISTANCE IF GPS_MANUAL (manual adjustment)
      if (fineData.location_source === "GPS_MANUAL") {
        // Verifica se temos a localização original
        if (!fineData.latitude_original || !fineData.longitude_original) {
          throw new FineLocationNotProvidedAdjustmentValidationError();
        }

        // A validação de distância já é feita pelo schema com isWithinAllowedDistance
        // Log de auditoria (opcional)
        console.log(`[AUDIT] GPS ajustado por ${userId} na multa`);
      } else if (!fineData.location_source) {
        // Se não tem source, é GPS automático
        fineData.location_source = "GPS_AUTO";

        // Copia localização final para original (não foi editada)
        fineData.latitude_original = fineData.latitude;
        fineData.longitude_original = fineData.longitude;
      }
    } else if (fineData.created_from === "WEB_DASHBOARD") {
      // Web: Location is OPTIONAL
      if (fineData.latitude && fineData.longitude) {
        fineData.location_source = "USER_MANUAL";
      } else {
        fineData.location_source = "NONE";
      }
    }

    // Add audit fields for web dashboard manual location
    if (
      fineData.created_from === "WEB_DASHBOARD" &&
      fineData.latitude &&
      fineData.longitude
    ) {
      (fineData as any).location_edited_by = userId;
      (fineData as any).location_edited_at = new Date();
    }

    try {
      const fineCreated = await this.fine.createFine(fineData);

      // Process notifications asynchronously without blocking the main flow
      this.processNotifications({
        fineCreated,
        findUser,
        findDriver,
        findVehicle,
        findBranch,
        findTrafficViolationCode,
        userId,
        businessId: fineData.businessId,
      });

      return fineCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar registrar a multa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateFineUseCase };
