import { Decimal } from "@prisma/client/runtime/library";

interface Part {
  id: string;
  description: string;
  unit_price: Decimal | string;
  businessId?: string | null;
  supplierId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
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

interface ListPartBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface ListPartByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

export {
  Part,
  CreatePartProps,
  UpdatePart,
  ListPartProps,
  ListPartByBusinessIdProps,
  ListPartBusinessProps,
  UpdatePartProps,
};
