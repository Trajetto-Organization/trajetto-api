import { describe, expect, it, vi } from "vitest";

import { OpenProofLinkUseCase } from "@/modules/integration/usecases/proof-link/open-proof-link-usecase";
import { proofLinkToken } from "@/shared/integration/proof-link";
import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

/**
 * Opening an integrator's proof link (plan of 02/11/2026, L7): the token is
 * the authorisation, so every refusal — malformed, forged, another tenant's
 * signature, expired, a delivery that has not ended — is the same 404, and
 * only a genuine link reaches the document, of the delivery's OWN company.
 */
const DELIVERY = "0192f7f0-5c1e-7a3b-9d2e-4f6a8b0c1d2e";
const BUSINESS = "0192f7e0-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const OTHER = "0192f7e0-1a2b-7c3d-8e4f-5a6b7c8d9e10";

const DAY_MS = 24 * 60 * 60 * 1000;

function build(
  target: {
    businessId: string;
    status: string;
    created_at: Date;
  } | null,
) {
  const integration = {
    findProofLinkTarget: vi.fn().mockResolvedValue(target),
  };
  const proofs = {
    executeForProofLink: vi
      .fn()
      .mockResolvedValue({ url: "https://r2.exemplo/comprovante.pdf" }),
  };

  return {
    integration,
    proofs,
    useCase: new OpenProofLinkUseCase(integration as never, proofs as never),
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
    return "opened";
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    throw error;
  }
}

const now = new Date("2026-11-03T12:00:00.000Z");
const recent = new Date(now.getTime() - 3 * DAY_MS);

describe("opening a proof link", () => {
  it("hands back the document of the delivery's own company", async () => {
    const { useCase, proofs } = build({
      businessId: BUSINESS,
      status: "DELIVERED",
      created_at: recent,
    });

    await expect(
      useCase.execute(proofLinkToken(DELIVERY, BUSINESS), now),
    ).resolves.toBe("https://r2.exemplo/comprovante.pdf");

    expect(proofs.executeForProofLink).toHaveBeenCalledWith({
      businessId: BUSINESS,
      deliveryId: DELIVERY,
    });
  });

  it("opens a failed delivery's receipt too", async () => {
    const { useCase } = build({
      businessId: BUSINESS,
      status: "FAILED",
      created_at: recent,
    });

    expect(
      await refusal(useCase.execute(proofLinkToken(DELIVERY, BUSINESS), now)),
    ).toBe("opened");
  });

  it("answers the same 404 to every link that is not genuine and current", async () => {
    const cases: Array<[string, Parameters<typeof build>[0], string]> = [
      ["malformed", null, "lixo"],
      ["unknown delivery", null, proofLinkToken(DELIVERY, BUSINESS)],
      [
        "signed for another company",
        { businessId: BUSINESS, status: "DELIVERED", created_at: recent },
        proofLinkToken(DELIVERY, OTHER),
      ],
      [
        "delivery still open",
        { businessId: BUSINESS, status: "IN_TRANSIT", created_at: recent },
        proofLinkToken(DELIVERY, BUSINESS),
      ],
      [
        "delivery cancelled",
        { businessId: BUSINESS, status: "CANCELLED", created_at: recent },
        proofLinkToken(DELIVERY, BUSINESS),
      ],
      [
        "past the receipt's public life",
        {
          businessId: BUSINESS,
          status: "DELIVERED",
          created_at: new Date(
            now.getTime() - (env.PROOF_VERIFICATION_TTL_DAYS + 1) * DAY_MS,
          ),
        },
        proofLinkToken(DELIVERY, BUSINESS),
      ],
    ];

    for (const [label, target, token] of cases) {
      const { useCase, proofs } = build(target);

      expect(await refusal(useCase.execute(token, now)), label).toBe(
        "404 PROOF_NOT_FOUND",
      );
      expect(proofs.executeForProofLink, label).not.toHaveBeenCalled();
    }
  });

  it("answers the 404 too when the delivery reopens between the check and the document, and lets a 503 through", async () => {
    const reopened = build({
      businessId: BUSINESS,
      status: "DELIVERED",
      created_at: recent,
    });

    reopened.proofs.executeForProofLink.mockRejectedValueOnce(
      new AppError("Em andamento.", 409, "DELIVERY_NOT_SETTLED"),
    );

    expect(
      await refusal(
        reopened.useCase.execute(proofLinkToken(DELIVERY, BUSINESS), now),
      ),
    ).toBe("404 PROOF_NOT_FOUND");

    const busy = build({
      businessId: BUSINESS,
      status: "DELIVERED",
      created_at: recent,
    });

    busy.proofs.executeForProofLink.mockRejectedValueOnce(
      new AppError("Tente de novo.", 503, "PROOF_SIGNING_FAILED"),
    );

    expect(
      await refusal(
        busy.useCase.execute(proofLinkToken(DELIVERY, BUSINESS), now),
      ),
    ).toBe("503 PROOF_SIGNING_FAILED");
  });

  it("does not touch the database for a token that is not shaped like one", async () => {
    const { useCase, integration } = build(null);

    await refusal(useCase.execute(`${DELIVERY}.curta`, now));

    expect(integration.findProofLinkTarget).not.toHaveBeenCalled();
  });
});
