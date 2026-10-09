import {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsPage,
} from "../dtos/status-change-reason-dto";

/**
 * The company's own vocabulary for why a delivery's status was overridden.
 *
 * Shaped after IOccurrenceTypeRepository on purpose: same catalogue problem,
 * same answers. Support reads both together in the timeline, and two
 * catalogues that behaved differently would be two things to explain.
 */
interface IStatusChangeReasonRepository {
  createStatusChangeReason: (
    reasonData: CreateStatusChangeReasonProps,
  ) => Promise<StatusChangeReason>;

  /**
   * The page (search + Status filter, in the list's order), the count per
   * status over the search alone, and how many of those some event cites.
   */
  listStatusChangeReasons: (
    props: ListStatusChangeReasonsProps,
  ) => Promise<ListStatusChangeReasonsPage>;

  /** The picker's vocabulary: active reasons only, lean payload. */
  listActiveStatusChangeReasons: (businessId: string) => Promise<
    Array<{ id: string; name: string; description: string | null }>
  >;

  findStatusChangeReasonById: (
    reasonId: string,
  ) => Promise<StatusChangeReason | null>;

  findStatusChangeReasonByName: (
    businessId: string,
    name: string,
  ) => Promise<StatusChangeReason | null>;

  updateStatusChangeReason: (
    reasonId: string,
    reasonData: UpdateStatusChangeReasonProps,
  ) => Promise<StatusChangeReason>;

  deleteStatusChangeReason: (reasonId: string) => Promise<StatusChangeReason>;

  /**
   * How many events cite this reason.
   *
   * Asked before a hard delete. The foreign key is ON DELETE RESTRICT, so
   * Postgres would refuse anyway — this turns that refusal into a sentence
   * with a number instead of a 500, and points at deactivating, which is what
   * the operator retiring a reason actually wants.
   */
  countEventsByReasonId: (reasonId: string) => Promise<number>;
}

export { IStatusChangeReasonRepository };
