import { Decimal } from "@prisma/client/runtime/library";

interface Part {
  id: string;
  description: string;
  unit_price: Decimal | string;
  businessId?: string | null;
  supplierId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  supplier?: {
    name: string;
  } | null;
  business?: {
    corporate_reason: string;
  } | null;
}

interface CreatePartProps {
  description: string;
  unit_price: number;
  businessId: string;
  supplierId?: string | null;
}

interface UpdatePartProps {
  description?: string;
  unit_price?: number;
  supplierId?: string | null;
  businessId?: string;
}

interface UpdatePart {
  partData: UpdatePartProps;
  partId: string;
}

interface ListPartProps {
  data: Part[];
  total: number;
}

interface ListPartByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

interface SearchPartWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedPart {
  data: Part[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  Part,
  CreatePartProps,
  UpdatePart,
  ListPartProps,
  ListPartByBusinessIdProps,
  UpdatePartProps,
  SearchPartWithCursorProps,
  CursorPaginatedPart,
};
