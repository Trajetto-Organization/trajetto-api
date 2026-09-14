interface OccurrenceType {
  id?: string;
  name: string;
  description?: string | null;
  requires_photo?: boolean;
  blocks_delivery?: boolean;
  is_active?: boolean;
  businessId: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface CreateOccurrenceTypeProps {
  name: string;
  description?: string | null;
  requires_photo?: boolean;
  blocks_delivery?: boolean;
  businessId: string;
}

interface UpdateOccurrenceTypeProps {
  name?: string | null;
  description?: string | null;
  requires_photo?: boolean;
  blocks_delivery?: boolean;
  is_active?: boolean;
}

interface ListOccurrenceTypesProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
}

interface ListOccurrenceTypesResult {
  data: OccurrenceType[];
  total: number;
  /** Rides along in the NDJSON meta line — feeds the panel cards. */
  meta?: {
    total: number;
    active: number;
    blocking: number;
    requiringPhoto: number;
  };
}

export {
  OccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesResult,
};
