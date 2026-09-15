interface StatusChangeReason {
  id?: string;
  name: string;
  description?: string | null;
  is_active?: boolean;
  businessId: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface CreateStatusChangeReasonProps {
  name: string;
  description?: string | null;
  businessId: string;
}

interface UpdateStatusChangeReasonProps {
  name?: string | null;
  description?: string | null;
  is_active?: boolean;
}

interface ListStatusChangeReasonsProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
}

interface ListStatusChangeReasonsResult {
  data: StatusChangeReason[];
  total: number;
  /** Rides along in the NDJSON meta line — feeds the panel cards. */
  meta?: {
    total: number;
    active: number;
    used: number;
  };
}

export {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsResult,
};
