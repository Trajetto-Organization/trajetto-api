import { FastifyReply } from "fastify";

import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

import { Decimal } from "@prisma/client/runtime/library";

interface ListResponse<T> {
  data: T[];
  total: number;
  meta?: any;
}

interface sendAsNDJSONProps<T> {
  dataPromise: Promise<ListResponse<T>>;
  reply: FastifyReply;
  page?: number;
  pageSize?: number;
}

/**
 * Recursively converts Prisma Decimal objects to numbers
 * This ensures proper JSON serialization in NDJSON streaming
 * Preserves Date objects for proper serialization
 */
function convertDecimalsToNumbers(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (obj instanceof Decimal) {
    return obj.toNumber();
  }

  // Preserve Date objects - don't convert them
  if (obj instanceof Date) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => convertDecimalsToNumbers(item));
  }

  if (typeof obj === "object") {
    const converted: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        converted[key] = convertDecimalsToNumbers(obj[key]);
      }
    }

    return converted;
  }

  return obj;
}

async function sendAsNDJSON<T>({
  reply,
  dataPromise,
  page,
  pageSize,
}: sendAsNDJSONProps<T>): Promise<void> {
  // Resolve validations/database work before committing a 200 streaming
  // response. Rejections are handled by Fastify's normal error contract.
  const result = await dataPromise;

  // Configure headers for streaming
  reply.header("Content-Type", "application/x-ndjson");
  reply.header("Transfer-Encoding", "chunked");

  reply.header("Cache-Control", "no-cache");
  reply.header("Connection", "keep-alive");

  const dataStream = new Readable({
    objectMode: true,
    read() {}, // Implementation is manually controlled
  });

  // Send metadata as the first record
  const metaInfo = {
    meta: {
      total: result.total,
      page,
      pageSize,
      ...(result.meta && { searchMeta: result.meta }),
    },
  };

  dataStream.push(`${JSON.stringify(metaInfo)}\n`);

  for (const item of result.data) {
    const convertedItem = convertDecimalsToNumbers(item);
    dataStream.push(`${JSON.stringify(convertedItem)}\n`);
  }

  dataStream.push(null);

  // If the client accepts gzip, apply compression
  const acceptEncoding = reply.request.headers["accept-encoding"];

  if (acceptEncoding && acceptEncoding.includes("gzip")) {
    reply.header("Content-Encoding", "gzip");
    return reply.send(dataStream.pipe(createGzip()));
  }

  return reply.send(dataStream);
}

export { sendAsNDJSON };
