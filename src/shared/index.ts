import { container } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";

import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { BranchRepository } from "@/modules/branch/repositories/branch-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { ProfileAccessRepository } from "@/modules/profile-access/repositories/profile-access-repository";
import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { PermissionRepository } from "@/modules/permission/repositories/permission-repository";
import { IPermissionRepository } from "@/modules/permission/repositories/IPermission-repository";

import { IUsersTokensRepository } from "@/modules/user/repositories/IUsers-tokens-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";

import { SupplierRepository } from "@/modules/supplier/repositories/supplier-repository";
import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { VehicleTypeRepository } from "@/modules/vehicle-type/repositories/vehicle-type-repository";
import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";

import { FuelTypeRepository } from "@/modules/fuel-type/repositories/fuel-type-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";

import { PartRepository } from "@/modules/part/repositories/part-repository";
import { IPartRepository } from "@/modules/part/repositories/IPart-repository";

import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { ServiceOrderPartRepository } from "@/modules/service-order-part/repositories/service-order-part-repository";
import { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";

import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";
import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { IDashboardRepository } from "@/modules/dashboard/repositories/IDashboard-repository";
import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";

import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { IActivityRepository } from "@/modules/activity/repositories/IActivity-repository";

import { NotificationRepository } from "@/modules/notification/repositories/notification-repository";
import { INotificationRepository } from "@/modules/notification/repositories/INotification-repository";

import { IQuoteRepository } from "@/modules/quote/repositories/IQuote-repository";
import { QuoteRepository } from "@/modules/quote/repositories/quote-repository";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { KanbanRepository } from "@/modules/kanban/repositories/kanban-repository";

import { FineRepository } from "@/modules/fine/repositories/fine-repository";
import { TrafficViolationCodeRepository } from "@/modules/fine/repositories/traffic-violation-code-repository";

import { IFineRepository } from "@/modules/fine/repositories/IFine-repository";
import { ITrafficViolationCodeRepository } from "@/modules/fine/repositories/ITraffic-violation-code-repository";

import { IWhatsAppProvider } from "./providers/whatsapp-provider/IWhatsApp-provider";
import { EvolutionApiProvider } from "./providers/whatsapp-provider/implementations/evolution-api-provider";

import { NotificationService } from "./services/notification-service";

container.registerSingleton<IWhatsAppProvider>(
  "WhatsAppProvider",
  EvolutionApiProvider,
);

container.registerSingleton<IUserRepository>("UserRepository", UserRepository);
container.registerSingleton<IUsersTokensRepository>(
  "UsersTokensRepository",
  UserTokensRepository,
);

container.registerSingleton<IBusinessRepository>(
  "BusinessRepository",
  BusinessRepository,
);
container.registerSingleton<IBranchRepository>(
  "BranchRepository",
  BranchRepository,
);

container.registerSingleton<ISupplierRepository>(
  "SupplierRepository",
  SupplierRepository,
);
container.registerSingleton<IVehicleTypeRepository>(
  "VehicleTypeRepository",
  VehicleTypeRepository,
);

container.registerSingleton<IFuelTypeRepository>(
  "FuelTypeRepository",
  FuelTypeRepository,
);
container.registerSingleton<IPartRepository>("PartRepository", PartRepository);

container.registerSingleton<IDriverRepository>(
  "DriverRepository",
  DriverRepository,
);
container.registerSingleton<IVehicleRepository>(
  "VehicleRepository",
  VehicleRepository,
);

container.registerSingleton<IServiceOrderRepository>(
  "ServiceOrderRepository",
  ServiceOrderRepository,
);
container.registerSingleton<IServiceOrderPartRepository>(
  "ServiceOrderPartRepository",
  ServiceOrderPartRepository,
);

container.registerSingleton<IAccountPayableRepository>(
  "AccountPayableRepository",
  AccountPayableRepository,
);

container.registerSingleton<IProfileAccessRepository>(
  "ProfileAccessRepository",
  ProfileAccessRepository,
);
container.registerSingleton<IPermissionRepository>(
  "PermissionRepository",
  PermissionRepository,
);

container.registerSingleton<IDashboardRepository>(
  "DashboardRepository",
  DashboardRepository,
);

container.registerSingleton<IActivityRepository>(
  "ActivityRepository",
  ActivityRepository,
);
container.registerSingleton<INotificationRepository>(
  "NotificationRepository",
  NotificationRepository,
);

container.registerSingleton<IKanbanRepository>(
  "KanbanRepository",
  KanbanRepository,
);
container.registerSingleton<IQuoteRepository>(
  "QuoteRepository",
  QuoteRepository,
);

container.registerSingleton<IFineRepository>("FineRepository", FineRepository);
container.registerSingleton<ITrafficViolationCodeRepository>(
  "TrafficViolationCodeRepository",
  TrafficViolationCodeRepository,
);

container.registerSingleton<NotificationService>(
  "NotificationService",
  NotificationService,
);
