import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import {
  driverDeviceParamsSchema,
  driverLoginParamsSchema,
} from "@/schemas/driver-access-schema";

import {
  ListDriverDevicesUseCase,
  RevokeDriverDeviceUseCase,
} from "./driver-devices-usecases";

class ListDriverDevicesController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { userId } = driverLoginParamsSchema.parse(request.params);

    const devices = await container
      .resolve(ListDriverDevicesUseCase)
      .execute({ actorId: request.user.id, userId });

    return reply.status(200).send({
      data: devices.map((device) => ({
        deviceId: device.device_id,
        sessions: device.sessions,
        lastActivityAt: device.last_activity_at.toISOString(),
        expiresAt: device.expires_at.toISOString(),
      })),
    });
  }
}

class RevokeDriverDeviceController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { userId, deviceId } = driverDeviceParamsSchema.parse(request.params);

    await container
      .resolve(RevokeDriverDeviceUseCase)
      .execute({ actorId: request.user.id, userId, deviceId });

    return reply.status(204).send();
  }
}

export { ListDriverDevicesController, RevokeDriverDeviceController };
