import type { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { businessDateKey, dateOnlyFromKey } from "@/shared/time/business-day";
import { pauseTypeId } from "./pause-type-seed";

/**
 * One carrier with one record of every kind a route can name by id.
 *
 * The IDOR sweep seeds two of these: the attacker's company, whose ids fill
 * every slot except the one being probed (so the request reaches the lookup
 * that matters instead of failing on the first id), and the victim's, whose
 * id goes into the probed slot. Every free-text field of the victim carries
 * SECRET_MARKER, so any response that leaks a victim row can be spotted
 * without knowing its shape.
 */
const SECRET_MARKER = "ZZSEGREDOB";

type CarrierIds = Record<string, string>;

function digits(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
}

async function seedSweepCarrier(
  prisma: PrismaClient,
  options: { label: string; marker: string; openPause?: boolean },
): Promise<CarrierIds> {
  const tag = `${options.marker} ${options.label}`;
  const ids: CarrierIds = {};

  const business = await prisma.business.create({
    data: {
      corporate_reason: `${tag} ${randomUUID()}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: digits(14),
      cnae: "4930202",
      responsible_name: tag,
      telephone: "11999999999",
      email: `sweep-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 50,
    },
  });
  ids.businessId = business.id;

  for (const module of ["FLEET", "DELIVERIES"] as const) {
    await prisma.businessEntitlement.create({
      data: { businessId: business.id, module, enabled: true },
    });
  }

  const businessId = business.id;

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `${tag} filial`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: digits(14),
      cnae: "4930202",
      responsible_name: tag,
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId,
    },
  });
  ids.branchId = branch.id;

  const profile = await prisma.profileAccess.create({
    data: {
      name: `${tag} perfil`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey: "fleet_manage",
            action: `${tag} permissão`,
            canRead: true,
            canWrite: true,
            businessId,
          },
        ],
      },
    },
    include: { permissions: true },
  });
  ids.profileAccessId = profile.id;
  ids.permissionId = profile.permissions[0].id;

  const user = await prisma.user.create({
    data: {
      name: `${tag} usuária`,
      email: `sweep-user-${randomUUID()}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_USER",
      businessId,
      profileAccessId: profile.id,
    },
  });
  ids.userId = user.id;

  const supplier = await prisma.supplier.create({
    data: { name: `${tag} fornecedor`, cnpj: digits(14), businessId },
  });
  ids.supplierId = supplier.id;

  const fuelType = await prisma.fuelType.create({
    data: { description: `${tag} diesel`, businessId },
  });
  ids.fuelTypeId = fuelType.id;

  const vehicleType = await prisma.vehicleType.create({
    data: { description: `${tag} truck`, number_of_axles: 2, businessId },
  });
  ids.vehicleTypeId = vehicleType.id;

  const driver = await prisma.driver.create({
    data: {
      name: `${tag} motorista`,
      birth_date: new Date("1990-01-01"),
      cnh: digits(11),
      cpf: digits(11),
      rg: digits(9),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
      branchId: branch.id,
    },
  });
  ids.driverId = driver.id;

  const vehicle = await prisma.vehicle.create({
    data: {
      description: `${tag} veículo`,
      license_plate: `ZZ${digits(5)}`,
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 1000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: digits(11),
      manufacturing_year: new Date("2020-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId,
      fuelTypeId: fuelType.id,
      vehicleTypeId: vehicleType.id,
      branchId: branch.id,
    },
  });
  ids.vehicleId = vehicle.id;

  const part = await prisma.part.create({
    data: { description: `${tag} peça`, unit_price: 10, businessId, supplierId: supplier.id },
  });
  ids.partId = part.id;

  const serviceOrder = await prisma.serviceOrder.create({
    data: {
      maintenance_type: "INTERNAL",
      total_amount: 10,
      businessId,
      vehicleId: vehicle.id,
      responsibleUserId: user.id,
      branchId: branch.id,
      description: `${tag} ordem`,
    },
  });
  ids.serviceOrderId = serviceOrder.id;

  const serviceOrderPart = await prisma.serviceOrderPart.create({
    data: {
      unit_price: 10,
      quantity: 1,
      businessId,
      serviceOrderId: serviceOrder.id,
      partId: part.id,
    },
  });
  ids.serviceOrderPartId = serviceOrderPart.id;

  const accountPayable = await prisma.accountPayable.create({
    data: {
      due_date: new Date(),
      amount: 10,
      businessId,
      branchId: branch.id,
      registrationUserId: user.id,
      description: `${tag} conta`,
    },
  });
  ids.accountPayableId = accountPayable.id;

  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 1100,
      liters_amount: 10,
      price_per_liter: 5,
      total_amount: 50,
      odometer_photo: `uploads/${businessId}/odometer.jpg`,
      businessId,
      branchId: branch.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
      fuelTypeId: fuelType.id,
    },
  });
  ids.fuelId = fuel.id;

  const checklist = await prisma.vehicleChecklist.create({
    data: {
      current_mileage: 1200,
      tires_condition: tag,
      bumpers_condition: tag,
      windshield_condition: tag,
      mirrors_condition: tag,
      steering_wheel_condition: tag,
      battery_condition: tag,
      spare_tire_condition: tag,
      overall_condition: tag,
      businessId,
      branchId: branch.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
    },
  });
  ids.checklistId = checklist.id;

  const violation = await prisma.trafficViolationCode.create({
    data: {
      code: `SW${digits(6)}`,
      description: "Infração de teste",
      legal_basis: "Art. 1",
      violator_type: "Condutor",
      gravity: "LIGHT",
      gravity_raw: "Leve",
      points: 3,
      competent_agency: "Órgão",
    },
  });
  ids.trafficViolationCodeId = violation.id;

  const fine = await prisma.fine.create({
    data: {
      violation_date: new Date(),
      due_date: new Date(),
      amount: 100,
      points: 3,
      businessId,
      branchId: branch.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      trafficViolationCodeId: violation.id,
      observation: `${tag} multa`,
    },
  });
  ids.fineId = fine.id;

  const column = await prisma.kanbanColumn.create({
    data: { title: `${tag} coluna`, color: "#000000", position: 0, businessId },
  });
  ids.columnId = column.id;

  const card = await prisma.kanbanCard.create({
    data: {
      title: `${tag} cartão`,
      description: tag,
      priority: "LOW",
      dueDate: new Date(),
      position: 0,
      columnId: column.id,
      assignedUserId: user.id,
    },
  });
  ids.cardId = card.id;

  const notification = await prisma.notification.create({
    data: { type: "INFO", title: tag, message: tag, userId: user.id, businessId },
  });
  ids.notificationId = notification.id;

  const shipper = await prisma.shipper.create({
    data: { name: `${tag} embarcador`, businessId },
  });
  ids.shipperId = shipper.id;

  const occurrenceType = await prisma.occurrenceType.create({
    data: {
      name: `${tag} ocorrência`,
      businessId,
      category: "NOT_DELIVERED",
      requires_authorization: true,
    },
  });
  ids.occurrenceTypeId = occurrenceType.id;

  ids.pauseTypeId = await pauseTypeId(prisma, businessId, "MEAL");

  const reason = await prisma.statusChangeReason.create({
    data: { name: `${tag} motivo`, businessId },
  });
  ids.reasonId = reason.id;

  const importRow = await prisma.import.create({
    data: {
      source: "SPREADSHEET",
      filename: `${tag}.xlsx`,
      report: { note: tag },
      businessId,
      performedById: user.id,
    },
  });
  ids.importId = importRow.id;

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `${tag} destinatário`,
      city: "São Paulo",
      uf: "SP",
      street: `${tag} rua`,
      businessId,
      shipperId: shipper.id,
      status: "PENDING",
      scheduled_date: new Date(Date.UTC(2026, 9, 7)),
    },
  });
  ids.deliveryId = delivery.id;

  // A second, unrouted delivery: the planning routes take only those.
  const loose = await prisma.delivery.create({
    data: {
      recipient_name: `${tag} solta`,
      city: "São Paulo",
      uf: "SP",
      street: `${tag} rua`,
      businessId,
      shipperId: shipper.id,
      status: "PENDING",
    },
  });
  ids.looseDeliveryId = loose.id;

  const route = await prisma.route.create({
    data: {
      code: randomInt(80_000, 90_000),
      name: `${tag} rota`,
      businessId,
      driverId: driver.id,
      vehicleId: vehicle.id,
      status: "PLANNED",
      scheduled_date: new Date(Date.UTC(2026, 9, 7)),
    },
  });
  ids.routeId = route.id;

  const stop = await prisma.routeStop.create({
    data: { sequence: 1, routeId: route.id, deliveryId: delivery.id },
  });
  ids.stopId = stop.id;

  // The driver's day: a released route with its own stop, so a driver's
  // probes reach the lookup instead of "this route is not yours yet".
  const onTheStreet = await prisma.delivery.create({
    data: {
      recipient_name: `${tag} em rota`,
      city: "São Paulo",
      uf: "SP",
      street: `${tag} rua`,
      businessId,
      shipperId: shipper.id,
      status: "PENDING",
      driverId: driver.id,
      scheduled_date: dateOnlyFromKey(businessDateKey(new Date(), "America/Sao_Paulo")),
    },
  });
  ids.driverDeliveryId = onTheStreet.id;

  const journey = await prisma.route.create({
    data: {
      code: randomInt(90_000, 99_999),
      name: `${tag} jornada`,
      businessId,
      driverId: driver.id,
      vehicleId: vehicle.id,
      status: "RELEASED",
      released_at: new Date(),
      scheduled_date: dateOnlyFromKey(businessDateKey(new Date(), "America/Sao_Paulo")),
    },
  });
  ids.journeyRouteId = journey.id;

  const journeyStop = await prisma.routeStop.create({
    data: { sequence: 1, routeId: journey.id, deliveryId: onTheStreet.id },
  });
  ids.journeyStopId = journeyStop.id;

  const occurrence = await prisma.deliveryOccurrence.create({
    data: {
      description: tag,
      deliveryId: delivery.id,
      businessId,
      occurrenceTypeId: occurrenceType.id,
      reportedById: user.id,
      authorization_status: "PENDING",
      category: "NOT_DELIVERED",
    },
  });
  ids.occurrenceId = occurrence.id;

  const audit = await prisma.deliveryProofAudit.create({
    data: { deliveryId: delivery.id, businessId },
  });
  ids.auditId = audit.id;

  const thread = await prisma.chatThread.create({
    data: { businessId, driverId: driver.id },
  });
  ids.threadId = thread.id;

  const ticket = await prisma.supportTicket.create({
    data: {
      number: randomInt(1, 1_000_000),
      kind: "DRIVER",
      subject: `${tag} atendimento`,
      businessId,
      threadId: thread.id,
      driverId: driver.id,
      opened_via: "PANEL",
    },
  });
  ids.ticketId = ticket.id;

  const message = await prisma.chatMessage.create({
    data: {
      kind: "TEXT",
      body: `${tag} mensagem`,
      threadId: thread.id,
      senderId: user.id,
      ticketId: ticket.id,
    },
  });
  ids.messageId = message.id;

  // Ended: an open pause would turn every "start" probe into "already
  // paused", and ending an ended pause is the idempotent replay the "end"
  // probes compare against.
  const pauseSubmission = randomUUID();
  const pause = await prisma.driverPause.create({
    data: {
      kind: "MEAL",
      started_at: new Date(Date.now() - 60 * 60 * 1000),
      ended_at: options.openPause ? null : new Date(Date.now() - 30 * 60 * 1000),
      end_submission_id: options.openPause ? null : randomUUID(),
      start_submission_id: pauseSubmission,
      driverId: driver.id,
      businessId,
      occurrenceTypeId: ids.pauseTypeId,
      note: tag,
    },
  });
  ids.pauseId = pause.id;
  ids.pauseSubmissionId = pauseSubmission;

  const key = generateApiKey();
  const apiKey = await prisma.apiKey.create({
    data: {
      name: `${tag} chave`,
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["routes:read", "deliveries:read", "deliveries:write", "events:read"],
      businessId,
    },
  });
  ids.apiKeyId = apiKey.id;
  ids.apiKeyToken = key.token;

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `${tag} webhook`,
      url: "https://example.com/hook",
      secret: `whsec_${randomUUID()}`,
      businessId,
      topics: ["delivery.created"],
    },
  });
  ids.endpointId = endpoint.id;

  const webhookDelivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      topic: "delivery.created",
      payload: { note: tag },
      signature: "sig",
      businessId,
      status: "FAILED",
    },
  });
  ids.webhookDeliveryId = webhookDelivery.id;

  return ids;
}

/** An access token for a fresh user of the company, with a live session. */
async function sweepToken(
  prisma: PrismaClient,
  businessId: string,
  role: "BUSINESS_ADMIN" | "DRIVER",
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: role === "DRIVER" ? "Motorista atacante" : "Gestora atacante",
      email: `sweep-actor-${id}@exemplo.com.br`,
      password: "not-used-here",
      role: role === "DRIVER" ? "BUSINESS_USER" : "BUSINESS_ADMIN",
      businessId,
      driverId: role === "DRIVER" ? driverId : undefined,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: id,
    expiresIn: "30m",
  });
}

export { SECRET_MARKER, seedSweepCarrier, sweepToken };
export type { CarrierIds };
