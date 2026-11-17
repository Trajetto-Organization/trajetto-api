import type { ArchiveStorage } from "./archive-storage";

/**
 * The archive storage of the tests: objects in a Map, with the same
 * semantics as the bucket — a put appears whole or not at all, a second put
 * of a key replaces the first, and deleting an absent key is no error.
 * `failPutAfter` makes the next puts throw once that many bytes went in, as
 * a connection lost half-way through a multipart upload would.
 */
class InMemoryArchiveStorage implements ArchiveStorage {
  readonly objects = new Map<string, Buffer>();

  /** Every key a put completed, in order: a rewrite shows up twice. */
  readonly puts: string[] = [];

  failPutAfter: number | null = null;

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Buffer[] = [];
    let received = 0;

    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;

      if (this.failPutAfter !== null && received > this.failPutAfter) {
        throw new Error(`conexão perdida no envio de ${key}`);
      }
    }

    this.objects.set(key, Buffer.concat(chunks));
    this.puts.push(key);
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

export { InMemoryArchiveStorage };
