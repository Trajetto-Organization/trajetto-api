import type { SortOrder } from "@/shared/pagination/list-query";
import type { OccurrenceFormField } from "../form/occurrence-form-rules";
import type { ActiveStatus, YesNo } from "@/shared/delivery/catalog-list";
import type {
  OccurrenceCategoryKey,
  PauseKindKey,
} from "../rules/occurrence-category-rules";
import type {
  OccurrenceTypeGroup,
  OccurrenceTypeListSearchMeta,
  OccurrenceTypeSortKey,
} from "../usecases/list-occurrence-type/occurrence-type-list";

interface OccurrenceType {
  id?: string;
  name: string;
  description?: string | null;
  requires_photo?: boolean;
  blocks_delivery?: boolean;
  is_active?: boolean;
  /**
   * A type the platform writes itself ("Comprovante rejeitado", from the
   * proof audit): kept in the company's catalogue for the history, never
   * offered to the driver or counted as a driver report.
   */
  is_system?: boolean;
  /**
   * The questions of the type's form (decision 6.2), as stored (a Json
   * column): read it through readFormFields. Null = no form.
   */
  form_fields?: unknown;
  /** Bumped whenever form_fields changes. */
  form_version?: number;
  /** A driver's report waits for the tower (decision 6.3). */
  requires_authorization?: boolean;
  /** Decision 14.3: what reporting it means. */
  category?: OccurrenceCategoryKey;
  /** The receipt photo ("canhoto"), camera only, read by the AI when contracted. */
  requires_receipt_photo?: boolean;
  requires_signature?: boolean;
  /** PAUSE only: the legal nature the Lei 13.103 report reads. */
  pause_kind?: PauseKindKey | null;
  /** The platform's handle on a seeded default; never sent to clients. */
  system_key?: string | null;
  /** When is_active last went false; null while active. */
  deactivated_at?: Date | null;
  businessId: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

/** A row of the catalogue screen: the type plus what the dialog locks on. */
interface OccurrenceTypeListRow extends Omit<OccurrenceType, "system_key"> {
  /** A seeded default (system_key set): editable, never deletable. */
  is_default: boolean;
  /** An occurrence or a pause names it: category and nature are locked. */
  in_use: boolean;
}

interface CreateOccurrenceTypeProps {
  name: string;
  description?: string | null;
  requires_photo?: boolean;
  blocks_delivery?: boolean;
  requires_authorization?: boolean;
  /** Already normalized (normalizeFormFields); null = no form. */
  form_fields?: OccurrenceFormField[] | null;
  category?: OccurrenceCategoryKey;
  requires_receipt_photo?: boolean;
  requires_signature?: boolean;
  pause_kind?: PauseKindKey | null;
  businessId: string;
}

interface UpdateOccurrenceTypeProps {
  name?: string | null;
  description?: string | null;
  requires_photo?: boolean;
  blocks_delivery?: boolean;
  is_active?: boolean;
  requires_authorization?: boolean;
  /**
   * Undefined keeps the form; null clears it. The use case sends it only when
   * it changed, and the repository writes it with a form_version increment in
   * the same statement.
   */
  form_fields?: OccurrenceFormField[] | null;
  category?: OccurrenceCategoryKey;
  requires_receipt_photo?: boolean;
  requires_signature?: boolean;
  pause_kind?: PauseKindKey | null;
  /** Written by the use case with is_active: now() off, null on. */
  deactivated_at?: Date | null;
}

/** What the driver's app needs of a type (the my-deliveries payload). */
interface ActiveOccurrenceType {
  id: string;
  name: string;
  description: string | null;
  requires_photo: boolean;
  blocks_delivery: boolean;
  requires_authorization: boolean;
  form_fields: OccurrenceFormField[] | null;
  form_version: number;
  category: OccurrenceCategoryKey;
  requires_receipt_photo: boolean;
  requires_signature: boolean;
}

/** A DELIVERED type as the app's proof screen needs it (decision 14.3). */
interface DeliveredOccurrenceType extends ActiveOccurrenceType {
  is_default: boolean;
}

/** A PAUSE type as the app's pause picker needs it (decision 14.4). */
interface PauseOccurrenceType {
  id: string;
  name: string;
  pause_kind: PauseKindKey;
  is_default: boolean;
}

interface ListOccurrenceTypesProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
  sort?: OccurrenceTypeSortKey;
  order?: SortOrder;
  /** The filters; none (or every value) keeps every type. */
  statuses?: ActiveStatus[];
  blocking?: YesNo[];
  photo?: YesNo[];
  categories?: OccurrenceCategoryKey[];
}

/** The page and the grouped counts the cards and the filters are built from. */
interface ListOccurrenceTypesPage {
  data: OccurrenceTypeListRow[];
  groups: OccurrenceTypeGroup[];
}

interface ListOccurrenceTypesResult {
  data: OccurrenceTypeListRow[];
  total: number;
  /** Rides along in the NDJSON meta line: the cards and the filter counts. */
  meta: OccurrenceTypeListSearchMeta;
}

export {
  ActiveOccurrenceType,
  DeliveredOccurrenceType,
  OccurrenceType,
  OccurrenceTypeListRow,
  PauseOccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesPage,
  ListOccurrenceTypesResult,
};
