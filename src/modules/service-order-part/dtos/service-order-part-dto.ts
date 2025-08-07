import { Decimal } from "@prisma/client/runtime/library";

interface ServiceOrderPart {
  id: string;
  unit_price: Decimal | string;
  quantity: number;
  discount_percentage: Decimal | string | null;
  businessId: string;
  serviceOrderId: string;
  partId: string;
  created_at: Date | string;
  updated_at: Date | string;

  // Extended fields
  partDescription?: string;
  partUnitPrice?: string;
  totalPrice?: string;
  totalWithDiscount?: string;
}

interface CreateServiceOrderPartProps {
  unit_price: number;
  quantity: number;
  discount_percentage?: number | null;
  businessId: string;
  serviceOrderId: string;
  partId: string;
}

interface UpdateServiceOrderPartProps {
  unit_price?: number;
  quantity?: number;
  discount_percentage?: number | null;
  partId?: string;
  serviceOrderId?: string;
  businessId?: string;
}

interface UpdateServiceOrderPart {
  serviceOrderPartData: UpdateServiceOrderPartProps;
  serviceOrderPartId: string;
}

interface ListServiceOrderPartProps {
  data: ServiceOrderPart[];
  total: number;
}

interface ListServiceOrderPartByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

export {
  ServiceOrderPart,
  CreateServiceOrderPartProps,
  UpdateServiceOrderPartProps,
  UpdateServiceOrderPart,
  ListServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
};
