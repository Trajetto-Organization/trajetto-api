import { FastifyInstance } from "fastify";

import { dashboardRoutes } from "./dashboard-routes";
import { notificationRoutes } from "./notification-routes";

import { activityRoutes } from "./activity-routes";

import { businessRoutes } from "./business-routes";
import { branchRoutes } from "./branch-routes";

import { supplierRoutes } from "./supplier-routes";
import { profileAccessRoutes } from "./profile-access-routes";

import { vehicleTypeRoutes } from "./vehicle-type-routes";

import { fuelTypeRoutes } from "./fuel-type-routes";
import { fuelRoutes } from "./fuel-routes";

import { partRoutes } from "./part-routes";
import { driverRoutes } from "./driver-routes";

import { vehicleRoutes } from "./vehicle-routes";
import { vehicleChecklistRoutes } from "./vehicle-checklist-routes";

import { serviceOrderRoutes } from "./service-order-routes";

import { serviceOrderPartRoutes } from "./service-order-part-routes";
import { accountPayableRoutes } from "./account-payable-routes";

import { permissionRoutes } from "./permission-routes";
import { quoteRoutes } from "./quote-routes";

import { userRoutes } from "./user-routes";
import { kanbanRoutes } from "./kanban.routes";

import { fineRoutes } from "./fine-routes";
import { trafficViolationCodeRoutes } from "./traffic-violation-code-routes";

import { routingRoutes } from "./routing-routes";
import { simulationRoutes } from "./simulation-routes";

import { vehicleAssignmentRoutes } from "./vehicle-assignment-routes";
import { fleetAnalyticsRoutes } from "./fleet-analytics-routes";

import { healthRoutes } from "./health-routes";
import { whatsappRoutes } from "./whatsapp-routes";

async function routes(app: FastifyInstance) {
  app.register(dashboardRoutes, { prefix: "/dashboard" });
  app.register(notificationRoutes, { prefix: "/notification" });
  app.register(activityRoutes, { prefix: "/activity" });
  app.register(businessRoutes, { prefix: "/business" });
  app.register(branchRoutes, { prefix: "/branch" });
  app.register(supplierRoutes, { prefix: "/supplier" });
  app.register(vehicleTypeRoutes, { prefix: "/vehicle-type" });
  app.register(fuelTypeRoutes, { prefix: "/fuel-type" });
  app.register(fuelRoutes, { prefix: "/fuel" });
  app.register(partRoutes, { prefix: "/part" });
  app.register(driverRoutes, { prefix: "/driver" });
  app.register(vehicleRoutes, { prefix: "/vehicle" });
  app.register(vehicleChecklistRoutes, { prefix: "/vehicle-checklist" });
  app.register(serviceOrderRoutes, { prefix: "/service-order" });
  app.register(serviceOrderPartRoutes, { prefix: "/service-order-part" });
  app.register(accountPayableRoutes, { prefix: "/account-payable" });
  app.register(profileAccessRoutes, { prefix: "/profile-access" });
  app.register(permissionRoutes, { prefix: "/permission" });
  app.register(userRoutes, { prefix: "/user" });
  app.register(quoteRoutes, { prefix: "/quote" });
  app.register(kanbanRoutes, { prefix: "/kanban" });
  app.register(fineRoutes, { prefix: "/fines" });
  app.register(trafficViolationCodeRoutes, { prefix: "/traffic-violation" });
  app.register(routingRoutes, { prefix: "/routes" });
  app.register(simulationRoutes, { prefix: "/simulations" });
  app.register(vehicleAssignmentRoutes, { prefix: "/vehicle-assignment" });
  app.register(fleetAnalyticsRoutes, { prefix: "/fleet-analytics" });
  app.register(whatsappRoutes, { prefix: "/whatsapp" });
  app.register(healthRoutes);
}

export { routes };
