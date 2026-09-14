interface Shipper {
  id?: string;
  name: string;
  cnpj?: string | null;
  email?: string | null;
  telephone?: string | null;
  is_active?: boolean;
  businessId: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface CreateShipperProps {
  name: string;
  cnpj?: string | null;
  email?: string | null;
  telephone?: string | null;
  businessId: string;
}

interface UpdateShipperProps {
  name?: string | null;
  cnpj?: string | null;
  email?: string | null;
  telephone?: string | null;
  is_active?: boolean;
}

interface ListShippersProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
}

interface SearchShipperWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedShipper {
  data: Shipper[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ListShippersResult {
  data: Shipper[];
  total: number;
  /** Rides along in the NDJSON meta line — feeds the panel cards. */
  meta?: { total: number; active: number; withCnpj: number };
}

export {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersResult,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
};
