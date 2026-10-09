/**
 * Reads at most `limitBytes` of a response body, then stops listening.
 *
 * The webhook monitor keeps the first kilobyte of what a customer's endpoint
 * answered. It used to get there by reading the WHOLE body and truncating
 * afterwards — and fetch decompresses gzip and brotli on its own, so an
 * endpoint answering with a few megabytes of gzip handed the worker gigabytes
 * of string. The dispatcher runs inside every API replica: one tenant's
 * endpoint took down HTTP, sockets and every other worker, and the row it
 * left behind took down the next replica that claimed it.
 *
 * The limit counts DECOMPRESSED bytes, which is what memory pays for.
 */
async function readBoundedBody(
  // Only the body is read, typed by what is used: the dispatcher's Response
  // comes from undici's own fetch, and its stream type is not Node's global
  // one, although both are read the same way.
  response: {
    body: {
      getReader(): {
        read(): Promise<
          | { done: true; value?: Uint8Array }
          | { done: false; value: Uint8Array }
        >;
        cancel(): Promise<void>;
      };
    } | null;
  },
  limitBytes: number,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let received = 0;
  let text = "";

  try {
    while (received < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const room = limitBytes - received;
      const slice = value.byteLength > room ? value.subarray(0, room) : value;

      received += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
    }

    text += decoder.decode();
  } finally {
    // Stop the transfer: the rest of the body is never downloaded, and never
    // decompressed.
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

export { readBoundedBody };
