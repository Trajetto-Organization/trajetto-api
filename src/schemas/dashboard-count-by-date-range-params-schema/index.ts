import { z } from "zod";

const countByDateRangeParamsSchema = z.object({
  entity: z.enum([
    "vehicle",
    "driver",
    "business",
    "branch",
    "part",
    "supplier",
    "service-order",
    "user",
  ]),
});

export { countByDateRangeParamsSchema };
