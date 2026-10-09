import { describe, expect, it } from "vitest";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import {
  USER_BODY_LINK_RULES,
  USER_UPDATE_LINK_RULES,
} from "@/modules/user/usecases/errors/user-http-errors";
import { userResponses } from "@/routes/documentation/user-documentation";

/**
 * A user can no longer be moved to another company by an edit (decision
 * 16.100). The published refusals of update-user used to promise
 * BUSINESS_NOT_FOUND "for the company the MASTER moves the user to", and the
 * controller still mapped that error — documenting a move that is gone.
 */
describe("update-user refusals after the company move was removed", () => {
  it("no longer documents BUSINESS_NOT_FOUND for an edit", () => {
    const description = userResponses.updateUserErrors.description ?? "";

    expect(description).not.toContain("BUSINESS_NOT_FOUND");
    expect(description).toContain("businessId");
  });

  it("maps no company error on update, but keeps it on create", () => {
    const updateErrors = USER_UPDATE_LINK_RULES.map(([error]) => error);
    const createErrors = USER_BODY_LINK_RULES.map(([error]) => error);

    expect(updateErrors).not.toContain(BusinessNotFoundError);
    expect(createErrors).toContain(BusinessNotFoundError);
  });
});
