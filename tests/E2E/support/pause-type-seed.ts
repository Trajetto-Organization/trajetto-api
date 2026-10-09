import type { Prisma } from "@prisma/client";

import {
  DEFAULT_PAUSE_TYPE_KEY,
  ensureDefaultOccurrenceTypes,
} from "@/shared/delivery/default-occurrence-types";

type Client = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw" | "occurrenceType">;

/**
 * The company's seeded PAUSE type for a nature (decision 14.4), seeding the
 * defaults first. For tests that write driver_pause rows directly: the column
 * occurrenceTypeId is NOT NULL since 20261005120100_occurrence_categories.
 */
async function pauseTypeId(
  client: Client,
  businessId: string,
  kind: keyof typeof DEFAULT_PAUSE_TYPE_KEY,
): Promise<string> {
  await ensureDefaultOccurrenceTypes(client, businessId);

  const type = await client.occurrenceType.findUniqueOrThrow({
    where: {
      businessId_system_key: { businessId, system_key: DEFAULT_PAUSE_TYPE_KEY[kind] },
    },
    select: { id: true },
  });

  return type.id;
}

export { pauseTypeId };
