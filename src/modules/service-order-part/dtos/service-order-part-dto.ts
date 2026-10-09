import { Decimal } from "@prisma/client/runtime/library";

import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  ServiceOrderPartAggregate,
  ServiceOrderPartSortKey,
} from "../usecases/list-service-order-part/service-order-part-list";

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

/** What the repository answers; the use case turns it into searchMeta. */
interface ListServiceOrderPartProps {
  data: ServiceOrderPart[];
  /** Count, lines with a discount and value, over every filter. */
  aggregate: ServiceOrderPartAggregate;
  /** Part options with their counts (every filter but the part one). */
  partCounts: FacetCount[];
}

interface ListServiceOrderPartByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
  partIds?: string[];
  serviceOrderIds?: string[];
  sort?: ServiceOrderPartSortKey;
  order?: SortOrder;
}

/** An order's parts against its typed total (FLEET-SO-2). */
interface ServiceOrderTotals {
  totalAmount: number;
  partsTotal: number;
}

export {
  ServiceOrderPart,
  ServiceOrderTotals,
  CreateServiceOrderPartProps,
  UpdateServiceOrderPartProps,
  UpdateServiceOrderPart,
  ListServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
};
