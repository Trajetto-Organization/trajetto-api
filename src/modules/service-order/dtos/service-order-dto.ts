import { Decimal } from "@prisma/client/runtime/library";

interface ServiceOrder {
  id: string;
  date: Date | string;
  completion_date?: Date | string | null;
  maintenance_type: "INTERNAL" | "EXTERNAL";
  total_amount: Decimal | string;
  businessId: string;
  vehicleId: string;
  responsibleUserId: string;
  branchId: string;
  supplierId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;

  // 📸 SNAPSHOT: Vehicle data at the time the work order was created.
  current_mileage_at_service?: number | null;
  maintenance_interval_km_at_service?: number | null;
  last_maintenance_mileage_at_service?: number | null;

  // 🔧 NEW MILEAGE: Provided upon completion
  new_mileage_after_service?: number | null;

  // Extended fields for the interface only (do not exist in the database)
  vehicleLicensePlate?: string;
  vehicleDescription?: string;
  responsibleUserName?: string;
  branchName?: string;
  supplierName?: string;
  partsCount?: number;
}

interface CreateServiceOrderProps {
  date: Date | string;
  completion_date?: Date | null | string;
  maintenance_type: "INTERNAL" | "EXTERNAL";
  total_amount: number;
  current_mileage_at_service: number;
  maintenance_interval_km_at_service: number;
  last_maintenance_mileage_at_service?: number | null;
  new_mileage_after_service?: number | null;
  businessId: string;
  vehicleId: string;
  responsibleUserId: string;
  branchId: string;
  supplierId?: string | null;
}

interface UpdateServiceOrderProps {
  date?: Date | null | string;
  completion_date?: Date | null | string;
  maintenance_type?: "INTERNAL" | "EXTERNAL";
  total_amount?: number;
  new_mileage_after_service?: number | null;
  vehicleId?: string;
  responsibleUserId?: string;
  branchId?: string;
  supplierId?: string | null;
}

interface UpdateServiceOrder {
  serviceOrderData: UpdateServiceOrderProps;
  serviceOrderId: string;
}

interface ListServiceOrderProps {
  data: ServiceOrder[];
  total: number;
}

interface ListServiceOrderBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface ListServiceOrderByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

export {
  ServiceOrder,
  CreateServiceOrderProps,
  UpdateServiceOrderProps,
  UpdateServiceOrder,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  ListServiceOrderBusinessProps,
};
