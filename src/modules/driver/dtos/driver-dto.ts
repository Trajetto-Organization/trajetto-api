interface Driver {
  id: string;
  name: string;
  birth_date: Date | string;
  cnh: string;
  cpf: string;
  rg: string;
  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string;
  complement?: string | null;
  status: "ACTIVE" | "INACTIVE";
  contract_type: "OWNED" | "THIRD_PARTY";
  businessId: string;
  branchId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateDriverProps {
  name: string;
  birth_date: Date | string;
  cnh: string;
  cpf: string;
  rg: string;
  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string;
  complement?: string | null;
  status: "ACTIVE" | "INACTIVE";
  contract_type: "OWNED" | "THIRD_PARTY";
  businessId: string;
  branchId?: string | null;
}

interface UpdateDriverProps {
  name?: string;
  birth_date?: Date | string;
  cnh?: string;
  cpf?: string;
  rg?: string;
  cep?: string;
  city?: string;
  uf?: string;
  street?: string;
  address_number?: string;
  complement?: string | null;
  status?: "ACTIVE" | "INACTIVE";
  contract_type?: "OWNED" | "THIRD_PARTY";
  businessId?: string;
  branchId?: string | null;
}

interface UpdateDriver {
  driverData: UpdateDriverProps;
  driverId: string;
}

interface ListDriverProps {
  data: Driver[];
  total: number;
}

interface ListDriverByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

interface SearchDriverWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedDriver {
  data: Driver[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  Driver,
  CreateDriverProps,
  UpdateDriver,
  ListDriverProps,
  ListDriverByBusinessIdProps,
  UpdateDriverProps,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
};
