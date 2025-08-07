import { FastifyReply } from "fastify";

import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

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

async function sendAsNDJSON<T>({
  reply,
  dataPromise,
  page,
  pageSize,
}: sendAsNDJSONProps<T>): Promise<void> {
  // Configure headers for streaming
  reply.header("Content-Type", "application/x-ndjson");
  reply.header("Transfer-Encoding", "chunked");

  reply.header("Cache-Control", "no-cache");
  reply.header("Connection", "keep-alive");

  const dataStream = new Readable({
    objectMode: true,
    read() {}, // Implementation is manually controlled
  });

  try {
    const result = await dataPromise;

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

    // Sends each array item as an NDJSON line
    for (const item of result.data) {
      dataStream.push(`${JSON.stringify(item)}\n`);
    }

    dataStream.push(null); // End the stream
  } catch (error) {
    console.error("Error in sendAsNDJSON:", error);

    // Send error as NDJSON format
    const errorResponse = {
      error: {
        message: error instanceof Error ? error.message : "Erro desconhecido",
        code: "STREAM_ERROR",
      },
    };

    dataStream.push(`${JSON.stringify(errorResponse)}\n`);
    dataStream.push(null);
  }

  // If the client accepts gzip, apply compression
  const acceptEncoding = reply.request.headers["accept-encoding"];

  if (acceptEncoding && acceptEncoding.includes("gzip")) {
    reply.header("Content-Encoding", "gzip");
    return reply.send(dataStream.pipe(createGzip()));
  }

  return reply.send(dataStream);
}

export { sendAsNDJSON };
