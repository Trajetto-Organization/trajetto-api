import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";
import {
  presignedPhotoSchema,
  presignedPhotosSchema,
} from "@/schemas/presigned-photos-schema";

import { deliverySchemas } from "@/routes/documentation/delivery-documentation";

import { PhotoValidationService } from "@/shared/services/photo-validation-service";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";

/**
 * The bodies the driver's app has ALREADY queued.
 *
 * The app's outbox freezes a submission — URL, body and all — the moment the
 * driver presses send without signal, and sends it days later, to whatever
 * version of this API is running by then. Updating the app does not rewrite
 * what is already in the queue. So a schema change that refuses one of these
 * bodies does not "require an app update": it throws away every fueling,
 * checklist and proof that was sitting on a phone during the deploy, and
 * turns every resend of a record that already exists into a red "failed"
 * item.
 *
 * The rule these fixtures enforce: the create contracts the outbox feeds only
 * change additively. A new required field gets a server-side default; a
 * format only ever widens.
 *
 * The fixtures are APPEND-ONLY. When a test here fails, the fix is never to
 * edit the fixture — it is to make the server accept what the app already
 * sends. When the app starts sending a different shape, its bodies go in a
 * new `mobile-outbox-v2` folder beside this one, and v1 stays until no phone
 * can still hold one — the outbox keeps an item until it is sent or the
 * driver discards it, with no expiry.
 */
const FIXTURES = path.join(__dirname, "fixtures", "mobile-outbox-v1");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

/** What CreateFuelController applies, in its order, to a JSON body. */
function acceptFuel(
  body: Record<string, unknown>,
  schema: z.ZodTypeAny = createFuelSchema,
) {
  const { photo, ...fields } = body;

  expect(presignedPhotoSchema.safeParse(photo).success).toBe(true);

  return schema.parse(normalizeFormFields(fields));
}

/** What CreateVehicleChecklistController applies, in its order. */
function acceptChecklist(body: Record<string, unknown>) {
  const { photos, ...fields } = body;

  const presigned = presignedPhotosSchema.parse(photos) ?? [];
  const checklist = createVehicleChecklistSchema.parse(
    normalizeFormFields(fields),
  );

  const byField: Record<string, unknown[]> = {};

  for (const photo of presigned) {
    if (!photo.fieldName) continue;
    (byField[photo.fieldName] ??= []).push(photo);
  }

  const photoCheck = PhotoValidationService.validateRequiredPhotosProvided(
    checklist,
    byField,
  );

  expect(photoCheck.missingPhotos).toEqual([]);
  expect(photoCheck.isValid).toBe(true);

  return checklist;
}

describe("bodies the app's outbox already holds (mobile-outbox-v1)", () => {
  it("a fueling", () => {
    const parsed = acceptFuel(fixture("fuel"));

    expect(parsed.client_submission_id).toBe(
      "018fd960-0000-7000-8000-0000000000f1",
    );
    expect(parsed.current_mileage).toBe(12345.6);
  });

  it("a fueling whose location the driver nudged", () => {
    const parsed = acceptFuel(fixture("fuel-adjusted-location"));

    expect(parsed.location_source).toBe("GPS_MANUAL");
  });

  it("a checklist, with a failed item and its photo", () => {
    const parsed = acceptChecklist(fixture("checklist"));

    expect(parsed.brakes_working).toBe(false);
  });

  it("an arrival", () => {
    expect(() =>
      deliverySchemas.deliveryArrival.parse(fixture("delivery-arrival")),
    ).not.toThrow();
  });

  it("a proof of delivery with a signature", () => {
    expect(() =>
      deliverySchemas.deliveryProof.parse(fixture("delivery-proof")),
    ).not.toThrow();
  });

  it("an occurrence with a photo", () => {
    expect(() =>
      deliverySchemas.reportOccurrence.parse(fixture("delivery-occurrence")),
    ).not.toThrow();
  });
});

describe("the guard itself", () => {
  it("fails the moment a create contract demands a field the queue never had", () => {
    // What a careless N+1 looks like: one new required field.
    const stricter = z.intersection(
      createFuelSchema,
      z.object({ odometer_unit: z.enum(["km", "mi"]) }),
    );

    expect(() => acceptFuel(fixture("fuel"), stricter)).toThrow(
      /odometer_unit/,
    );
  });
});
