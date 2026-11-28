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

    // The phone goes out as its hash only (wave 2). `deviceId` carries the
    // same opaque value under the field's previous name, so a client that
    // still reads it gets the key DELETE takes, never the Android ID.
    return reply.status(200).send({
      data: devices.map((device) => ({
        deviceHash: device.device_hash,
        deviceId: device.device_hash,
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
    // The path's `deviceId` comes out of the schema as the phone's hash.
    const { userId, deviceId: deviceHash } = driverDeviceParamsSchema.parse(
      request.params,
    );

    await container
      .resolve(RevokeDriverDeviceUseCase)
      .execute({ actorId: request.user.id, userId, deviceHash });

    return reply.status(204).send();
  }
}

export { ListDriverDevicesController, RevokeDriverDeviceController };
