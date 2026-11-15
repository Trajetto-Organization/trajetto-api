import { describe, expect, it } from "vitest";

import { recipientsBesidesActor } from "@/shared/notifications/pipeline-rules";
import {
  aiVerificationIssuePolicy,
  renderAIVerificationIssueInApp,
} from "@/shared/notifications/policies/ai-verification-issue-policy";

const basePayload = {
  recordType: "fuel" as const,
  recordId: "fuel-1",
  businessId: "biz-1",
  vehiclePlate: "ABC1D23",
  vehicleDescription: "Fiorino",
  overallStatus: "fraud",
  details: "Suspeita de fraude: foto de tela.",
};

const ctx = { baseUrl: "https://app.trajetto.com" };

describe("ai-verification.issue policy", () => {
  /**
   * The recipients are the auditors, not the submitter — alerting the person
   * a fraud check is about would defeat its purpose.
   */
  it("notifies the business admins of the record's company", async () => {
    const seen: string[] = [];

    await aiVerificationIssuePolicy.resolveRecipients(basePayload, {
      userRepository: {
        findBusinessAdminsByBusinessId: async (businessId: string) => {
          seen.push(businessId);
          return [];
        },
      } as never,
    });

    expect(seen).toEqual(["biz-1"]);
  });

  /**
   * The admin who registered the record from the panel asked for the
   * reading, so they are the event's actor. The reading runs in the
   * background (the queue, its retries, the reconcile job hours later), and
   * the live `aiVerification` frame is a toast on a tab that is still open,
   * stored nowhere. Left out like the actor of every other topic, a company
   * with a single admin was told about a suspected fraud by nobody: no bell,
   * push, e-mail or WhatsApp.
   */
  it("still alerts the admin who asked for the reading, the company's only one", async () => {
    const admin = { id: "admin-1" };

    const resolved = await aiVerificationIssuePolicy.resolveRecipients(
      basePayload,
      {
        userRepository: {
          findBusinessAdminsByBusinessId: async () => [admin],
        } as never,
      },
    );

    expect(
      recipientsBesidesActor(
        resolved,
        admin.id,
        aiVerificationIssuePolicy.notifiesActor,
      ),
    ).toEqual([admin]);
  });

  it("renders a fraud headline with the vehicle and links to the record", () => {
    const rendered = renderAIVerificationIssueInApp(basePayload, ctx);

    expect(rendered.title).toContain("Suspeita de fraude");
    expect(rendered.message).toContain("ABC1D23");
    expect(rendered.link).toBe(
      "https://app.trajetto.com/dashboard/fuel?search=fuel-1&page=1",
    );
  });

  it("routes checklist issues to the checklist page", () => {
    const rendered = renderAIVerificationIssueInApp(
      {
        ...basePayload,
        recordType: "checklist",
        recordId: "check-1",
        overallStatus: "issues_found",
      },
      ctx,
    );

    expect(rendered.title).toContain("divergências");
    expect(rendered.link).toContain(
      "/dashboard/vehicle-checklist?search=check-1",
    );
  });

  it("survives a record without vehicle data", () => {
    const rendered = renderAIVerificationIssueInApp(
      { ...basePayload, vehiclePlate: null, vehicleDescription: null },
      ctx,
    );

    expect(rendered.message).not.toContain("null");
  });
});
