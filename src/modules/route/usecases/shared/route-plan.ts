import { AppError } from "@/shared/errors/AppError";

import {
  routePlanIssues,
  type RoutePlanInput,
} from "@/shared/route/route-plan-rules";

/**
 * Refuses a plan whose window breaks the rules (route-plan-rules), with the
 * first broken rule's message — the same sentence the web and the zod layer
 * give. 400, not 409: the request itself is wrong, and nothing about the
 * route's state would make it right.
 */
function assertRoutePlan(input: RoutePlanInput): void {
  const [issue] = routePlanIssues(input);

  if (issue) throw new AppError(issue.message, 400, "ROUTE_PLAN_INVALID");
}

export { assertRoutePlan };
