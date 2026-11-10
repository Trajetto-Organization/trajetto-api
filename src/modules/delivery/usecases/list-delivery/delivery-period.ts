import {
  LIST_PERIODS,
  MAX_CUSTOM_PERIOD_DAYS,
  listPeriodWindow,
  periodDateField,
  refineListPeriod,
  type ListPeriod,
  type ListPeriodInput,
  type ListPeriodWindow,
} from "@/shared/time/list-period";

/**
 * The deliveries listing's period (meeting of 14/10/2026).
 *
 * The Entregas screen opens on today: a carrier with ~3,000 deliveries a day
 * reads today's work, and a first page that counted the company's whole
 * history for the cards and the pager was the heaviest read of the board. The
 * period is a range of civil days in the company's zone (decision 1.1),
 * applied to created_at as [start of the first day, start of the day after
 * the last one).
 *
 * Absent, the listing covers every date: the public API, the chat's context
 * picker and every caller written before the period keep their answer.
 *
 * The presets, the cap and the rules are every listing's
 * (shared/time/list-period, Rotas reads them too); what is the deliveries'
 * own is the instant they apply to and the export's advice past the cap.
 */

const DELIVERY_PERIODS = LIST_PERIODS;

type DeliveryPeriod = ListPeriod;

type DeliveryPeriodInput = ListPeriodInput;

/** A period resolved in the company's zone; created_at >= start AND < end. */
type DeliveryPeriodWindow = ListPeriodWindow;

/**
 * The export takes the same filters and streams a year as well as a day:
 * past the cap, it is the way to a wider range.
 */
const refineDeliveryPeriod = refineListPeriod({
  tooLongAdvice: "Para um intervalo maior, exporte por partes.",
});

/**
 * The [start, end) a validated period covers in `timeZone`, or null for "every
 * date". `now` is the caller's clock; nothing here reads the server's zone.
 */
const deliveryPeriodWindow = listPeriodWindow;

export {
  DELIVERY_PERIODS,
  MAX_CUSTOM_PERIOD_DAYS,
  deliveryPeriodWindow,
  periodDateField,
  refineDeliveryPeriod,
  type DeliveryPeriod,
  type DeliveryPeriodInput,
  type DeliveryPeriodWindow,
};
