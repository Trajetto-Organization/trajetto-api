import type { SortOrder } from "@/shared/pagination/list-query";
import type { ActiveStatus } from "@/shared/delivery/catalog-list";
import type {
  StatusReasonGroup,
  StatusReasonListSearchMeta,
  StatusReasonSortKey,
} from "../usecases/list-status-change-reason/status-change-reason-list";

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
  sort?: StatusReasonSortKey;
  order?: SortOrder;
  /** The Status filter; none or both keeps every reason. */
  statuses?: ActiveStatus[];
}

/** The page and the counts the cards and the filter are built from. */
interface ListStatusChangeReasonsPage {
  data: StatusChangeReason[];
  groups: StatusReasonGroup[];
  /** Reasons of the search (no Status filter) some event already cites. */
  used: number;
}

interface ListStatusChangeReasonsResult {
  data: StatusChangeReason[];
  total: number;
  /** Rides along in the NDJSON meta line: the cards and the filter counts. */
  meta: StatusReasonListSearchMeta;
}

export {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsPage,
  ListStatusChangeReasonsResult,
};
