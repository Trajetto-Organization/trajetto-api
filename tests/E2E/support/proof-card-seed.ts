import { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";

/**
 * A proven delivery whose receipt card waits for the AI reading of
 * `photoPath`: the delivery, its PROOF event with that photo and the PENDING
 * card. The pipeline checks this before paying for a receipt reading (AI-4),
 * so a queued DELIVERY_PROOF request needs it to reach the provider at all.
 *
 * The company is created on first use when the test only had its id, as the
 * queue-mechanics tests do.
 */
const shipperByBusiness = new Map<string, string>();

async function ensureBusiness(prisma: PrismaClient, businessId: string) {
  const known = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true },
  });

  if (known) return;

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${businessId.slice(-4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      // Unique per company; nothing here validates the check digits.
      cnpj: String(randomInt(10_000_000, 99_999_999)) + "000190",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `proof-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function shipperOf(prisma: PrismaClient, businessId: string) {
  const known = shipperByBusiness.get(businessId);
  if (known) return known;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId },
  });

  shipperByBusiness.set(businessId, shipper.id);

  return shipper.id;
}

async function seedProofCard(
  prisma: PrismaClient,
  options: {
    businessId: string;
    photoPath: string;
    invoiceNumber?: string | null;
    reportedById?: string | null;
    signature?: string | null;
  },
): Promise<string> {
  await ensureBusiness(prisma, options.businessId);

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      invoice_number: options.invoiceNumber ?? null,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: options.businessId,
      shipperId: await shipperOf(prisma, options.businessId),
      status: "DELIVERED",
      delivered_at: new Date(),
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "PROOF",
      deliveryId: delivery.id,
      businessId: options.businessId,
      reportedById: options.reportedById ?? null,
      photo: options.photoPath,
      signature: options.signature ?? null,
      client_submission_id: randomUUID(),
    },
  });

  await prisma.deliveryProofAudit.create({
    data: { deliveryId: delivery.id, businessId: options.businessId },
  });

  return delivery.id;
}

export { seedProofCard };
