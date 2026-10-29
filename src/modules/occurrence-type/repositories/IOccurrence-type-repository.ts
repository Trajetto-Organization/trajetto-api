import {
  ActiveOccurrenceType,
  DeliveredOccurrenceType,
  OccurrenceType,
  PauseOccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesPage,
} from "../dtos/occurrence-type-dto";

interface IOccurrenceTypeRepository {
  /**
   * The type a system-generated occurrence needs, created on first use.
   *
   * Not seeded for every company: a carrier that never rejects a receipt
   * should not carry a word it never spends, and the catalogue screen is a
   * list of what this company actually says. Idempotent on (businessId, name),
   * which is the unique key the table already has.
   */
  ensureByName: (
    businessId: string,
    data: {
      name: string;
      description: string;
      blocks_delivery: boolean;
      requires_photo: boolean;
    },
  ) => Promise<{ id: string; name: string }>;

  createOccurrenceType: (
    occurrenceTypeData: CreateOccurrenceTypeProps,
  ) => Promise<OccurrenceType>;
  /**
   * The page (search + filters, in the list's order) and, over the search
   * alone, the count per combination of status, impeditiva and foto.
   */
  listOccurrenceTypes: (
    props: ListOccurrenceTypesProps,
  ) => Promise<ListOccurrenceTypesPage>;
  /**
   * The driver's NOT_DELIVERED vocabulary: active types only, lean payload,
   * with the form and the authorization flag the app needs to report
   * offline. DELIVERED and PAUSE types never ride here: the installed app
   * (contract <= 2) would offer them as problems (decision 14.3, §4.2).
   */
  listActiveOccurrenceTypes: (
    businessId: string,
  ) => Promise<ActiveOccurrenceType[]>;
  /** Active DELIVERED types, the seeded default first, then by name. */
  listActiveDeliveredTypes: (
    businessId: string,
  ) => Promise<DeliveredOccurrenceType[]>;
  /** Active PAUSE types, by name. */
  listActivePauseTypes: (businessId: string) => Promise<PauseOccurrenceType[]>;
  /**
   * Seeds the platform's defaults the company lacks (Entrega normal and the
   * three pause types). Idempotent and safe across replicas.
   */
  ensureDefaultTypes: (businessId: string) => Promise<void>;
  /** The seeded type with this system_key, active or not. */
  findDefaultType: (
    businessId: string,
    systemKey: string,
  ) => Promise<OccurrenceType | null>;
  /** Whether an occurrence or a pause names the type (its category is locked). */
  isOccurrenceTypeInUse: (occurrenceTypeId: string) => Promise<boolean>;
  findOccurrenceTypeById: (
    occurrenceTypeId: string,
  ) => Promise<OccurrenceType | null>;
  findOccurrenceTypeByName: (
    businessId: string,
    name: string,
  ) => Promise<OccurrenceType | null>;
  /**
   * `keepOneActiveOf`: the write takes the company's active types of that
   * category under FOR UPDATE and throws OccurrenceTypeLastOfCategoryError
   * when it would leave none active (two concurrent deactivations cannot
   * both pass).
   */
  updateOccurrenceType: (
    occurrenceTypeId: string,
    occurrenceTypeData: UpdateOccurrenceTypeProps,
    options?: { keepOneActiveOf?: "DELIVERED" | "PAUSE" },
  ) => Promise<OccurrenceType>;
  /**
   * `keepOneActiveOf`: the same locked check as the update's — deleting the
   * last active type of the category is as fatal as deactivating it.
   */
  deleteOccurrenceType: (
    occurrenceTypeId: string,
    options?: { keepOneActiveOf?: "DELIVERED" | "PAUSE" },
  ) => Promise<OccurrenceType>;
}

export { IOccurrenceTypeRepository };
