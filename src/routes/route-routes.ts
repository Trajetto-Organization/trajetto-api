import { FastifyInstance } from "fastify";

import { CreateRouteController } from "@/modules/route/usecases/create-route/create-route-controller";
import { UpdateRouteController } from "@/modules/route/usecases/update-route/update-route-controller";

import { ListRoutesController } from "@/modules/route/usecases/list-routes/list-routes-controller";
import { GetRouteController } from "@/modules/route/usecases/get-route/get-route-controller";

import { ReleaseRouteController } from "@/modules/route/usecases/release-route/release-route-controller";
import { StartRouteController } from "@/modules/route/usecases/start-route/start-route-controller";
import { CancelRouteController } from "@/modules/route/usecases/cancel-route/cancel-route-controller";

import { AddRouteStopsController } from "@/modules/route/usecases/add-route-stops/add-route-stops-controller";
import { RemoveRouteStopController } from "@/modules/route/usecases/remove-route-stop/remove-route-stop-controller";
import { ReorderRouteStopsController } from "@/modules/route/usecases/reorder-route-stops/reorder-route-stops-controller";

import { RecordDriverPositionsController } from "@/modules/route/usecases/record-driver-positions/record-driver-positions-controller";
import { ControlTowerController } from "@/modules/route/usecases/control-tower/control-tower-controller";
import { DriverTrailController } from "@/modules/route/usecases/driver-trail/driver-trail-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import { routeSchemas, routeResponses } from "./documentation/route-documentation";

const createRouteController = new CreateRouteController();
const updateRouteController = new UpdateRouteController();

const listRoutesController = new ListRoutesController();
const getRouteController = new GetRouteController();

const releaseRouteController = new ReleaseRouteController();
const startRouteController = new StartRouteController();
const cancelRouteController = new CancelRouteController();

const addRouteStopsController = new AddRouteStopsController();
const removeRouteStopController = new RemoveRouteStopController();
const reorderRouteStopsController = new ReorderRouteStopsController();

const recordDriverPositionsController = new RecordDriverPositionsController();
const controlTowerController = new ControlTowerController();
const driverTrailController = new DriverTrailController();

/**
 * The route is how deliveries are dispatched, so it lives behind the same
 * module switch and the same permission as the deliveries themselves.
 *
 * `delivery_manage` deliberately, rather than a `route_manage` of its own: a
 * user who can write deliveries can already assign a driver to twelve of them
 * through `PATCH /delivery/assign-deliveries`, which is the same act. A second
 * permission would not be a second lock — it would be a second door, and the
 * old one would stay unlocked.
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function routeRoutes(app: FastifyInstance) {
  app.post(
    "/create-route/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Plan a route for a driver",
        description:
          "Creates the day's work for one driver and turns the selected deliveries into stops, in the order sent. The route is born PLANNED — nothing reaches the driver until it is released. All-or-nothing: a delivery that is not PENDING, belongs to another company, or already has an open stop on another route rejects the whole request naming the offenders. The vehicle is optional here and required to release.",
        params: routeSchemas.businessIdParam,
        body: routeSchemas.createRoute,
        response: {
          201: routeResponses.routeCreated,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          422: routeResponses.validationError,
          500: routeResponses.internalServerError,
        },
      },
    },
    createRouteController.handle,
  );

  app.get(
    "/list-routes",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "List routes",
        description:
          "Responde em application/x-ndjson, NÃO em JSON: uma linha por valor. A PRIMEIRA linha é o envelope `{meta:{total,page,pageSize,searchMeta:{statusCounts}}}` e cada linha seguinte é uma rota completa, com suas paradas. Chamar response.json() nisso dá erro de parse — leia linha a linha (o front usa parseNDJSON). Quadro paginado, mais recente primeiro, com filtros por status, motorista e dia, e busca livre sobre o nome da rota, o nome do motorista e o código. A contagem por status descreve o conjunto FILTRADO, nunca a página. Usuário motorista só enxerga as próprias rotas — um driverId enviado por ele é substituído, não somado.",
        querystring: routeSchemas.listRoutes,
        response: {
          200: routeResponses.routeListEnvelope,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    listRoutesController.handle,
  );

  app.get(
    "/get-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Get one route with its stops",
        description:
          "The detail screen and the payload the driver's app opens: the route, its stops in the dispatcher's order, the delivery behind each one, and how many are already resolved. A route of another company — or of another driver, for a driver user — answers 404 rather than 403: a distinct 'exists but is not yours' would let anyone learn which ids are real.",
        params: routeSchemas.routeBusinessParams,
        response: {
          200: routeResponses.routeDetail,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    getRouteController.handle,
  );

  app.patch(
    "/update-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Edit the plan of a route",
        description:
          "Name, day, windows, driver and vehicle — never the status, which moves through release/start/cancel. Only a route that has not been executed may be edited (PLANNED or RELEASED); anything else answers 400 ROUTE_NOT_EDITABLE. If the route moves between reading this screen and saving it, the write lands on nothing and answers 409 rather than overwriting. Changing driver or vehicle also moves the shadow on the route's deliveries.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.updateRoute,
        response: {
          200: routeResponses.routeUpdated,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          422: routeResponses.validationError,
          500: routeResponses.internalServerError,
        },
      },
    },
    updateRouteController.handle,
  );

  app.patch(
    "/release-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Hand a route to its driver, or pull it back",
        description:
          "Releasing is the moment the route stops being a draft: from here the driver sees it in the app and can leave with it, which is why the vehicle, at least one stop and an active driver are all required one step before the departure strictly needs them — discovering at the truck that no vehicle was assigned costs a phone call and a morning. `released: false` returns it to planning, and only while no stop has been worked: once a stop has an outcome the route is a record of what the driver did.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.releaseRoute,
        response: {
          200: routeResponses.routeReleased,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    releaseRouteController.handle,
  );

  app.post(
    "/start-route/:routeId/business/:businessId",
    {
      // Driver surface: the app resends from its outbox after dead networks.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Driver departs with the route",
        description:
          "The departure, and the only one: it moves the route to IN_PROGRESS and puts its load on the street — the deliveries of the open stops become IN_TRANSIT in the same commit, which is what the app's next action (arrival, proof) requires. Only the route's own driver may start it; anyone else gets 404. `vehicleId` swaps the truck at the yard. A second departure on a vehicle that is already out is refused by the database with 409 ROUTE_VEHICLE_BUSY, and a resend of a route already IN_PROGRESS answers 409 ROUTE_STATUS_CONFLICT with nothing written.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.startRoute,
        response: {
          200: routeResponses.routeStarted,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          429: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    startRouteController.handle,
  );

  app.patch(
    "/cancel-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Cancel a route and release what it was holding",
        description:
          "The reason is required, and not as ceremony: cancelling a route that already left throws away a driver's morning, and the only way anyone reconstructs why is if the person who did it said so at the time. Cancelling also cancels the route's open stops and sends their deliveries back to the pool — status and ownership both — so they can go on another route; stops already resolved keep their outcome, because a delivery proven this morning was proven whatever happened to the route afterwards.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.cancelRoute,
        response: {
          200: routeResponses.routeCancelled,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          422: routeResponses.validationError,
          500: routeResponses.internalServerError,
        },
      },
    },
    cancelRouteController.handle,
  );

  // -------------------------------------------------------------------
  // Stops. Three endpoints, all of them planning: adding, removing and
  // ordering are things a dispatcher does before the route leaves.
  //
  // There is deliberately NO endpoint that moves a stop's status. The driver
  // acts on a DELIVERY — arrived, proved it, reported a problem — and the stop
  // is the route's view of that same act, settled in the same commit by the
  // delivery endpoints. A second writer would be a second truth. For the same
  // reason nothing here closes a route: it ends because its last stop did.
  // -------------------------------------------------------------------

  app.post(
    "/add-stops/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Add deliveries to a route as stops",
        description:
          "Appended at the end of the current order — where a stop goes is the dispatcher's decision, made by dragging, and guessing an insertion point would be a different guess from the one they are about to make. Only a route still in planning accepts new work: once it has departed, adding would change a plan the person on the road has already been given without telling them (409). A delivery already on this route, or on another one, is 409 with nothing written.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.addStops,
        response: {
          201: routeResponses.stopsAdded,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          422: routeResponses.validationError,
          500: routeResponses.internalServerError,
        },
      },
    },
    addRouteStopsController.handle,
  );

  app.delete(
    "/remove-stop/:stopId/route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Take a delivery off a route",
        description:
          "Deleted rather than cancelled, and it is the one place in this module where a row disappears: a stop removed while planning never happened, whereas a CANCELLED stop means the driver was sent there and it was called off. The delivery goes back to the unassigned pool keeping its own status — being taken off a route never changed it. A stop that does not exist, belongs to another route, or sits on a route that already departed all answer the same 404.",
        params: routeSchemas.routeStopParams,
        response: {
          200: routeResponses.stopRemoved,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    removeRouteStopController.handle,
  );

  app.patch(
    "/reorder-stops/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Rewrite the order the driver works the stops in",
        description:
          "Takes the COMPLETE list, not a move: a move instruction applied to a route a colleague has since changed silently produces an order nobody asked for, while a full list either describes the route as it is or describes one that no longer exists — and the second is refused with 409 ROUTE_REORDER_MISMATCH so the dispatcher refreshes and redoes it. A repeated stop id is 400, which is a different problem and not fixed by refreshing. Only a route still in planning can be reordered: after the departure the order is what the driver is following on the screen in their hand.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.reorderStops,
        response: {
          200: routeResponses.stopsReordered,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          409: routeResponses.conflictError,
          422: routeResponses.validationError,
          500: routeResponses.internalServerError,
        },
      },
    },
    reorderRouteStopsController.handle,
  );

  app.post(
    "/positions",
    {
      /**
       * The busiest route in the product, by an order of magnitude.
       *
       * A phone flushes every thirty seconds, and a whole fleet does it at
       * once. The ceiling is per user (the rate limiter keys on the session),
       * so one phone in a loop cannot spend the budget of the fleet — and 120
       * a minute is four times the normal cadence, which leaves room for a
       * device catching up after a dead zone without letting one run away.
       */
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "The driver's app reports where it is",
        description:
          "O motorista vem da SESSÃO e nunca do corpo: um driverId enviado aqui deixaria qualquer telefone escrever a trilha de qualquer pessoa, e a trilha é com o que uma disputa se resolve. Só grava enquanto uma rota do motorista está IN_PROGRESS — fora disso responde `tracking: false` e o app PARA, porque continuar é gastar a bateria de alguém num mapa que ninguém está olhando. Pontos imprecisos demais, com coordenada impossível ou com relógio adiantado são descartados silenciosamente e contados em `rejected`: o app é offline-first e reenvia, então recusar o lote faria o telefone repetir o mesmo ponto ruim para sempre. Um acúmulo de região sem sinal é aceito inteiro até o teto do lote; só o ÚLTIMO ponto vai para o websocket, senão cada painel aberto redesenharia o mesmo ponto duzentas vezes.",
        body: routeSchemas.recordPositions,
        response: {
          200: routeResponses.positionsRecorded,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          422: routeResponses.validationError,
          429: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    recordDriverPositionsController.handle,
  );

  app.get(
    "/control-tower",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Everything the control tower draws, in one request",
        description:
          "Um endpoint e não cinco: o painel atualiza tudo junto e cinco requisições num timer são cinco vezes as conexões para uma tela que o expedidor deixa aberta o dia inteiro. Os widgets são FIXOS — sem customização — então não há nada a negociar por cliente. Superfície do gestor: um token de motorista recebe 403 em vez da operação inteira. O mapa olha doze horas para trás e não \"hoje\", senão o turno da noite veria todo caminhão sumir à meia-noite; cada ponto vem com `fresh`, que separa \"onde ele está\" de \"onde ele esteve\". A pontualidade responde `null` quando nada foi planejado — uma taxa sobre zero rotas não é 100%, é impossível de responder, e 100% seria a tela mentindo no melhor dia dela.",
        querystring: routeSchemas.controlTower,
        response: {
          200: routeResponses.controlTower,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    controlTowerController.handle,
  );

  app.get(
    "/driver-trail/:driverId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Where one driver went on one day",
        description:
          "Pedido só quando alguém abre um motorista, nunca na atualização da torre: a torre desenha onde os caminhões ESTÃO, e buscar o dia inteiro de cada motorista a cada poucos segundos seria a consulta mais pesada do produto servindo enfeite. O resultado é afinado para no máximo quatrocentos pontos — um dia de dez horas a um ping por quinze segundos são 2.400 pontos para UM motorista, e a forma do trajeto é idêntica com um décimo deles. `recorded` diz quantos existem de verdade, porque quem visse só o desenhado concluiria que o telefone parou de reportar. Um motorista de outra empresa responde o mesmo 404 de um que não existe.",
        params: routeSchemas.driverTrailParams,
        querystring: routeSchemas.driverTrailQuery,
        response: {
          200: routeResponses.driverTrail,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    driverTrailController.handle,
  );
}

export { routeRoutes };
