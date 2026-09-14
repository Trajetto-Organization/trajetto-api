import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  /**
   * Scheme + host the client actually used to reach this API, when it can be
   * trusted (see `runWithRequestContext`).
   */
  publicBaseUrl?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Ambient, request-scoped facts that would otherwise have to be threaded
 * through every use case to reach one leaf.
 *
 * It exists for exactly one problem: in local-storage mode the API has to
 * hand back a URL to its own files, and the only correct host is the one the
 * caller reached it on. The browser on the dev machine reaches `localhost`;
 * the phone reaches the LAN address — and `localhost` on a phone is the
 * phone, which is why every image and voice note was silently dead there.
 *
 * The alternative was passing a base URL through sixteen call sites across
 * nine modules, none of which have anything to do with hosts. Keep this
 * storage for facts of that shape: ambient, request-scoped, and irrelevant to
 * the domain code they pass through. Anything the domain reasons about
 * belongs in the arguments, where it can be seen and tested.
 */
function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Binds the context to the rest of the current request.
 *
 * `enterWith` rather than `run` because a Fastify hook cannot wrap the
 * handlers that come after it — it can only make the store visible to
 * everything that continues on this asynchronous branch, which is precisely
 * the request being served.
 */
function enterRequestContext(context: RequestContext): void {
  storage.enterWith(context);
}

export { getRequestContext, enterRequestContext };
export type { RequestContext };
