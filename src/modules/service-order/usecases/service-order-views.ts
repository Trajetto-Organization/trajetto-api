import type { RecordOrigin } from "@prisma/client";

import type { ServiceOrderDetail } from "../dtos/service-order-dto";
import {
  partsTotalOf,
  type ServiceOrderStatus,
} from "./list-service-order/service-order-list";

/**
 * What an order looks like to whoever reads it (wave 3, owner's decision).
 *
 * The driver sees the orders he is responsible for and those of the vehicles
 * he operates, WITHOUT costs: the vehicle history the app read before
 * carried each part's unit price, the supplier and the responsible
 * (critique item 8), to a login that holds no part or payable key. So the
 * driver's view is an allowlist, built field by field: a column added to
 * the order later stays out of it until someone decides it belongs.
 *
 * Parts stay as name and quantity: what was done to the truck the driver
 * drives is his business, its price is not. No total, no unit price, no
 * discount, no supplier (the workshop is where the money goes).
 */
interface ServiceOrderDriverView {
  id: string;
  /** open until the order has a completion date (the web's two statuses). */
  status: ServiceOrderStatus;
  date: Date | string;
  completion_date: Date | string | null;
  maintenance_type: "INTERNAL" | "EXTERNAL";
  description: string | null;
  current_mileage_at_service: number | null;
  new_mileage_after_service: number | null;
  businessId: string;
  branchId: string;
  vehicleId: string;
  responsibleUserId: string;
  vehicle: { id: string; license_plate: string; description: string } | null;
  responsibleUser: { id: string; name: string } | null;
  branch: { id: string; corporate_reason: string } | null;
  parts: Array<{ id: string; description: string; quantity: number }>;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The office's view: the driver's, plus the money and the workshop. */
interface ServiceOrderFullView extends Omit<ServiceOrderDriverView, "parts"> {
  total_amount: number;
  /** Σ of the parts (unit price × quantity − discount), as on the list. */
  parts_total: number;
  maintenance_interval_km_at_service: number | null;
  last_maintenance_mileage_at_service: number | null;
  latitude: number | null;
  longitude: number | null;
  created_from: RecordOrigin;
  supplierId: string | null;
  supplier: { id: string; name: string } | null;
  parts: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_price: number;
    discount_percentage: number | null;
  }>;
}

type ServiceOrderRead =
  | { view: "driver"; serviceOrder: ServiceOrderDriverView }
  | { view: "full"; serviceOrder: ServiceOrderFullView };

function statusOf(order: Pick<ServiceOrderDetail, "completion_date">) {
  return (order.completion_date ? "completed" : "open") as ServiceOrderStatus;
}

function toServiceOrderDriverView(
  order: ServiceOrderDetail,
): ServiceOrderDriverView {
  return {
    id: order.id,
    status: statusOf(order),
    date: order.date,
    completion_date: order.completion_date ?? null,
    maintenance_type: order.maintenance_type,
    description: order.description ?? null,
    current_mileage_at_service: order.current_mileage_at_service ?? null,
    new_mileage_after_service: order.new_mileage_after_service ?? null,
    businessId: order.businessId,
    branchId: order.branchId,
    vehicleId: order.vehicleId,
    responsibleUserId: order.responsibleUserId,
    vehicle: order.vehicle
      ? {
          id: order.vehicle.id,
          license_plate: order.vehicle.license_plate,
          description: order.vehicle.description,
        }
      : null,
    responsibleUser: order.responsibleUser
      ? { id: order.responsibleUser.id, name: order.responsibleUser.name }
      : null,
    branch: order.branch
      ? { id: order.branch.id, corporate_reason: order.branch.corporate_reason }
      : null,
    parts: order.parts.map((line) => ({
      id: line.id,
      description: line.part.description,
      quantity: line.quantity,
    })),
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

function money(value: unknown): number {
  return Number(value ?? 0);
}

function toServiceOrderFullView(
  order: ServiceOrderDetail,
): ServiceOrderFullView {
  const base = toServiceOrderDriverView(order);

  return {
    ...base,
    // Decimal columns leave as numbers, like the NDJSON lists send them.
    total_amount: money(order.total_amount),
    parts_total: partsTotalOf(order.parts),
    maintenance_interval_km_at_service:
      order.maintenance_interval_km_at_service ?? null,
    last_maintenance_mileage_at_service:
      order.last_maintenance_mileage_at_service ?? null,
    latitude: order.latitude ?? null,
    longitude: order.longitude ?? null,
    created_from: order.created_from,
    supplierId: order.supplierId ?? null,
    supplier: order.supplier
      ? { id: order.supplier.id, name: order.supplier.name }
      : null,
    parts: order.parts.map((line) => ({
      id: line.id,
      description: line.part.description,
      quantity: line.quantity,
      unit_price: money(line.unit_price),
      discount_percentage:
        line.discount_percentage === null ||
        line.discount_percentage === undefined
          ? null
          : money(line.discount_percentage),
    })),
  };
}

export { toServiceOrderDriverView, toServiceOrderFullView };
export type { ServiceOrderDriverView, ServiceOrderFullView, ServiceOrderRead };
