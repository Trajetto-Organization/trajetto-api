import { container } from "tsyringe";

import { env } from "@/env";

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

import { ShipperRepository } from "@/modules/shipper/repositories/shipper-repository";
import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";

import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";

import { StatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/status-change-reason-repository";
import { IStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/IStatus-change-reason-repository";

import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { IImportRepository } from "@/modules/import/repositories/IImport-repository";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";

import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { IDriverPositionRepository } from "@/modules/route/repositories/IDriver-position-repository";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";
import type { IIntegrationRepository } from "@/modules/integration/repositories/IIntegration-repository";

import { ProofAuditRepository } from "@/modules/delivery/repositories/proof-audit-repository";
import type { IProofAuditRepository } from "@/modules/delivery/repositories/IProof-audit-repository";

import { DeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/delivery-message-template-repository";
import type { IDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/IDelivery-message-template-repository";

import { ExternalRecipientRepository } from "@/modules/delivery/repositories/external-recipient-repository";
import type { IExternalRecipientRepository } from "@/modules/delivery/repositories/IExternal-recipient-repository";

import { ProofDocumentRepository } from "@/modules/delivery/repositories/proof-document-repository";
import type { IProofDocumentRepository } from "@/modules/delivery/repositories/IProof-document-repository";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { DriverPositionRepository } from "@/modules/route/repositories/driver-position-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { IChatRepository } from "@/modules/chat/repositories/IChat-repository";

import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { VehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/vehicle-checklist-repository";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

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

import { IPendingDeletionProvider } from "./providers/pending-deletion-provider/IPendingDeletion-provider";
import { PendingDeletionProvider } from "./providers/pending-deletion-provider/pending-deletion-provider";

import { IWhatsAppProvider } from "./providers/whatsapp-provider/IWhatsApp-provider";
import { MetaCloudApiProvider } from "./providers/whatsapp-provider/implementations/meta-cloud-api-provider";

import { IMailProvider } from "./providers/mail-provider/IMail-provider";
import { ResendMailProvider } from "./providers/mail-provider/implementations/resend-mail-provider";

import { EtherealMailProvider } from "./providers/mail-provider/implementations/ethereal-mail-provider";

import { NotificationService } from "./services/notification-service";
import { KanbanService } from "./services/kanban-service";

import { UploadService } from "./services/upload-service";
import { OutboxService } from "./notifications/outbox-service";
import { WebhookFanOutService } from "./integration/webhook-fan-out-service";

container.registerSingleton<IWhatsAppProvider>(
  "WhatsAppProvider",
  MetaCloudApiProvider,
);

// Picked here now that the e-mail worker thread (which had its own factory)
// is gone: outside production every message goes to an Ethereal test inbox.
container.registerSingleton<IMailProvider>(
  "MailProvider",
  env.NODE_ENV === "production" ? ResendMailProvider : EtherealMailProvider,
);
container.registerSingleton<NotificationService>(
  "NotificationService",
  NotificationService,
);

container.registerSingleton<IPendingDeletionProvider>(
  "PendingDeletionProvider",
  PendingDeletionProvider,
);

container.registerSingleton<KanbanService>("KanbanService", KanbanService);
container.registerSingleton<UploadService>("UploadService", UploadService);

container.registerSingleton<OutboxService>("OutboxService", OutboxService);
container.registerSingleton<WebhookFanOutService>(
  "WebhookFanOutService",
  WebhookFanOutService,
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
container.registerSingleton<IFuelRepository>("FuelRepository", FuelRepository);

container.registerSingleton<IPartRepository>("PartRepository", PartRepository);
container.registerSingleton<IDriverRepository>(
  "DriverRepository",
  DriverRepository,
);

container.registerSingleton<IVehicleRepository>(
  "VehicleRepository",
  VehicleRepository,
);
container.registerSingleton<IVehicleChecklistRepository>(
  "VehicleChecklistRepository",
  VehicleChecklistRepository,
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

container.registerSingleton<IShipperRepository>(
  "ShipperRepository",
  ShipperRepository,
);
container.registerSingleton<IStatusChangeReasonRepository>(
  "StatusChangeReasonRepository",
  StatusChangeReasonRepository,
);

container.registerSingleton<IImportRepository>(
  "ImportRepository",
  ImportRepository,
);

container.registerSingleton<IOccurrenceTypeRepository>(
  "OccurrenceTypeRepository",
  OccurrenceTypeRepository,
);

container.registerSingleton<IDeliveryRepository>(
  "DeliveryRepository",
  DeliveryRepository,
);

container.registerSingleton<IRouteRepository>("RouteRepository", RouteRepository);

// Separate from the route repository on purpose: a write-heavy stream
// with one reader (a map), over a table partitioned by day.
container.registerSingleton<IDriverPositionRepository>(
  "DriverPositionRepository",
  DriverPositionRepository,
);

container.registerSingleton<IProofDocumentRepository>(
  "ProofDocumentRepository",
  ProofDocumentRepository,
);

container.registerSingleton<IExternalRecipientRepository>(
  "ExternalRecipientRepository",
  ExternalRecipientRepository,
);

container.registerSingleton<IDeliveryMessageTemplateRepository>(
  "DeliveryMessageTemplateRepository",
  DeliveryMessageTemplateRepository,
);

container.registerSingleton<IProofAuditRepository>(
  "ProofAuditRepository",
  ProofAuditRepository,
);

container.registerSingleton<IIntegrationRepository>(
  "IntegrationRepository",
  IntegrationRepository,
);

container.registerSingleton<IChatRepository>("ChatRepository", ChatRepository);
