import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";

import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import {
  DeliveryNotFoundError,
  DeliveryNotEditableError,
  DeliveryInvoiceKeyExistsError,
  DeliveryInvoiceKeyImmutableError,
  DeliveryItemsLockedError,
  DeliveryStatusConflictError,
} from "../errors/delivery-errors";

import {
  ShipperNotFoundError,
  ShipperInactiveError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { AppError } from "@/shared/errors/AppError";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { Delivery, UpdateDeliveryProps } from "../../dtos/delivery-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { isDeliveryEditable } from "@/shared/delivery/delivery-rules";
import {
  CLEARED_ADDRESS_POINT,
  addressChanged,
  editedAddress,
} from "@/shared/delivery/address-point";
import { deliveryAddressKey } from "@/shared/delivery/address-key";
import { geocodeSoon } from "@/shared/delivery/geocoding/geocode-soon";
import {
  deliveryEditChanges,
  deliveryEditNote,
} from "@/shared/delivery/delivery-edit-changes";

import database from "@/../infra/database";

import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { PlanBump } from "@/modules/route/dtos/route-dto";
import { announceDroppedPlans } from "@/modules/route/usecases/shared/route-plan-change";

interface UpdateDeliveryRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  deliveryData: UpdateDeliveryProps;
}

@injectable()
class UpdateDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    deliveryData,
  }: UpdateDeliveryRequest): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: the route guard must not be the only wall between
    // tenants (same check as get-delivery and the list/exports).
    assertTenantAccess(findUser, businessId);

    // One definition, shared: see assertDispatcher.
    assertDispatcher(findUser);

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    // Editing is limited to statuses where the cargo is not moving and the
    // outcome is not proven: pending and failed (awaiting redelivery). The
    // web's row menu reads the same rule (features/deliveries/lib/status.ts).
    if (!isDeliveryEditable(findDelivery.status)) {
      throw new DeliveryNotEditableError();
    }

    await this.assertInvoiceIdentity(findDelivery, deliveryData);

    // The NF-e's items are what the note declared; a typed delivery's items
    // are the dispatcher's text and may be corrected (decision 5.2).
    if (deliveryData.items !== undefined) {
      const source = await this.delivery.findDeliveryImportSource(deliveryId);

      if (source === "NFE_XML") {
        throw new DeliveryItemsLockedError();
      }
    }

    if (
      deliveryData.shipperId &&
      deliveryData.shipperId !== findDelivery.shipperId
    ) {
      const findShipper = await this.shipper.findShipperById(
        deliveryData.shipperId,
      );

      // Another company's id reads as absent (decision 11.3).
      if (!findShipper || findShipper.businessId !== businessId) {
        throw new ShipperNotFoundError();
      }

      // Only when it CHANGES, like the vehicle below: a delivery already on a
      // shipper deactivated since keeps it and can still be corrected. Moving
      // one onto a deactivated shipper is a new delivery for it (REV-14).
      if (findShipper.is_active === false) {
        throw new ShipperInactiveError();
      }
    }

    // No driver or vehicle here (DLV-EDIT-4): putting a delivery in a
    // driver's hands is an assignment, which builds the route and its stop
    // (assign-deliveries); the edit schema does not carry them.

    // What the edit really changes, against the row and its items as read:
    // the form resends every field, and a resend is not a change (K9).
    const changes = deliveryEditChanges(
      findDelivery,
      deliveryData.items !== undefined
        ? await this.delivery.findDeliveryItems(deliveryId)
        : [],
      deliveryData,
    );

    try {
      // The status the gate above approved, carried to the write. Reads sit
      // between them (import source, shipper), and that is the window in which
      // the driver proves the delivery.
      // The map point belongs to the address (design §4.11): a new address
      // with the old pin would put the stop where the delivery is not. The
      // new address's key goes with the cleared point, and the point another
      // delivery of the company has at the new door, when one has it, takes
      // the old one's place (address-point-reuse.ts) — read before the
      // write, so the lookup after the commit is asked only without one.
      const relocated = addressChanged(findDelivery, deliveryData);
      const addressKey = relocated
        ? deliveryAddressKey(editedAddress(findDelivery, deliveryData))
        : null;
      const reused = addressKey
        ? await this.delivery.findReusablePoint(
            businessId,
            addressKey,
            deliveryId,
          )
        : null;
      const data: UpdateDeliveryProps = relocated
        ? {
            ...deliveryData,
            ...CLEARED_ADDRESS_POINT,
            address_key: addressKey,
            ...reused,
          }
        : deliveryData;

      // A delivery on a route is on the driver's phone (K9). The route row
      // is taken first — the order every writer takes route then delivery
      // in, so a departure or a plan edit waits or wins — and the edit, the
      // plan's new version and the trail's line commit together.
      const { updated, bumps } = await database.$transaction(async (tx) => {
        const routeId =
          changes.length > 0
            ? await this.route.lockRouteOfOpenStop(deliveryId, businessId, tx)
            : null;

        const row = await this.delivery.updateDelivery(
          deliveryId,
          data,
          findDelivery.status,
          tx,
        );

        if (!routeId) return { updated: row, bumps: [] as PlanBump[] };

        await this.delivery.createDeliveryEvent(
          {
            type: "NOTE",
            deliveryId,
            actor: "USER",
            reportedById: userId,
            note: deliveryEditNote(changes),
            routeId,
          },
          tx,
        );

        return {
          updated: row,
          bumps: await this.route.bumpPlanVersions([routeId], businessId, tx),
        };
      });

      // After the commit: the screens refetch the plan, and the driver of a
      // released route is pushed (announcePlanChange).
      await announceDroppedPlans(this.user, businessId, bumps, userId);

      // The new address's point now, not at the next minute's job (E1):
      // the cleared bookkeeping re-queued it. Never awaited; not at all
      // when another delivery's point was taken — read from the row
      // written, as the write drops a copy whose root no longer held it.
      if (relocated && (updated.latitude ?? null) === null) {
        geocodeSoon(businessId, [deliveryId]);
      }

      return updated;
    } catch (error) {
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      // The key was free when checked above and taken before the write: the
      // unique index decided, the same 409 as the check.
      if (violatesUniqueOn(error, "invoice_key")) {
        throw new DeliveryInvoiceKeyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar atualizar a entrega! Por favor, tente novamente.",
        500,
      );
    }
  }

  /**
   * The NF-e key and number are set once (decision 5.2).
   *
   * Sending the value already stored is not a change (the form sends every
   * field it shows). A delivery without a key may receive one — the order is
   * often typed before the note is issued — and then an XML of the same note
   * is recognised as a duplicate instead of becoming a second delivery.
   */
  private async assertInvoiceIdentity(
    current: Delivery,
    patch: UpdateDeliveryProps,
  ): Promise<void> {
    const currentKey = current.invoice_key ?? null;

    const keyChanges =
      patch.invoice_key !== undefined &&
      (patch.invoice_key ?? null) !== currentKey;

    const numberChanges =
      patch.invoice_number !== undefined &&
      (patch.invoice_number ?? null) !== (current.invoice_number ?? null);

    if (currentKey !== null && (keyChanges || numberChanges)) {
      throw new DeliveryInvoiceKeyImmutableError();
    }

    if (keyChanges && patch.invoice_key) {
      const taken = await this.delivery.findDeliveryByInvoiceKey(
        current.businessId,
        patch.invoice_key,
      );

      if (taken && taken.id !== current.id) {
        throw new DeliveryInvoiceKeyExistsError();
      }
    }
  }
}

export { UpdateDeliveryUseCase };
