import { Decimal } from "@prisma/client/runtime/library";

interface Fine {
  id: string;
  violation_date: Date | string;
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: Decimal | string;
  points: number;
  location?: string | null;
  observation?: string | null;
  businessId: string;
  branchId: string;
  driverId: string;
  vehicleId: string;
  trafficViolationCodeId: string;
  created_at: Date | string;
  updated_at: Date | string;

  // Extended fields for interface (do not exist in the bank)
  businessName?: string;
  branchName?: string;
  driverName?: string;
  driverCpf?: string;
  vehicleLicensePlate?: string;
  vehicleDescription?: string;
  violationCode?: string;
  violationDescription?: string;
}

interface CreateFineProps {
  violation_date: Date | string;
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: number;
  points: number;
  location?: string | null;
  observation?: string | null;
  businessId: string;
  branchId: string;
  driverId: string;
  vehicleId: string;
  trafficViolationCodeId: string;
}

interface UpdateFineProps {
  violation_date?: Date | string;
  due_date?: Date | string;
  payment_date?: Date | string | null;
  amount?: number;
  points?: number;
  location?: string | null;
  observation?: string | null;
  branchId?: string;
  driverId?: string;
  vehicleId?: string;
  trafficViolationCodeId?: string;
}

interface UpdateFine {
  fineData: UpdateFineProps;
  fineId: string;
}

interface ListFineProps {
  data: Fine[];
  total: number;
}

interface ListFineByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

export {
  Fine,
  CreateFineProps,
  UpdateFineProps,
  UpdateFine,
  ListFineProps,
  ListFineByBusinessIdProps,
};
