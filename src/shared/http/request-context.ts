import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  /**
   * The request's id (a uuid v7, or the caller's well-formed x-request-id).
   * The outbox stamps it on every event the request publishes, so a delivery
   * can be traced back to the request that caused it (OBS-06).
   */
  requestId?: string;

  /**
   * Scheme + host the client actually used to reach this API, when it can be
   * trusted (see `runWithRequestContext`).
   */
  publicBaseUrl?: string;

  /**
   * Rows already loaded in this request, by key.
   *
   * It exists for one measured problem: every authenticated request loads the
   * full user TWICE. Once in `ensureAuthenticated`, to decide whether the
   * session is real, and once again inside the use case, because use cases
   * take a `userId` and look it up themselves. With the business, its
   * entitlements and the profile's permissions riding along, that is three
   * queries — on every request in the product. At the measured saturation
   * point of ~195 requests a second that is ~600 queries a second answering a
   * question that was answered a millisecond earlier.
   *
   * The obvious fix — hand the user down from the middleware — would change
   * the signature of every use case in the product and tie them to Fastify,
   * which is exactly what the plain `userId` argument exists to avoid. So the
   * memory goes UNDER the repository, and every caller stays as it was.
   *
   * Scoped to the request and never to the process. A process-wide cache of
   * users would be a correctness problem with a timer attached: somebody
   * revokes an access profile and the next N seconds of traffic still see the
   * old permissions. Within ONE request the user cannot change under itself,
   * except by that same request writing to it — and every write forgets.
   *
   * `null` is a real entry: "this id does not exist" is an answer worth not
   * asking twice, and the not-found path is the one a probing caller repeats.
   */
  rows?: Map<string, unknown>;

  /**
   * Set once the response is over (see `endRequestContext`). An ended context
   * reads as no context at all.
   */
  ended?: boolean;
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
  const context = storage.getStore();

  return context && !context.ended ? context : undefined;
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

/**
 * Ends a request's context once its response is over.
 *
 * `enterWith` also binds the store to every async resource created during the
 * request — a Redis or database connection opened lazily by the first
 * request, a timer — and those outlive it. Whatever later ran through them (a
 * Socket.IO handshake, a socket event, a worker tick) found that first
 * request's store and its memoised user: after a session_version bump every
 * handshake compared the token against the old row and was refused. Ending
 * the context makes a leaked store inert, wherever it went.
 */
function endRequestContext(context: RequestContext): void {
  context.ended = true;
  context.rows = undefined;
}

/**
 * Reads through the request's memory, or loads and remembers.
 *
 * Outside a request — workers, cron jobs, scripts — there is no store and the
 * loader simply runs, so the only difference between the two worlds is how
 * many times the database is asked.
 */
async function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
  const context = getRequestContext();

  if (!context) return load();

  const rows = (context.rows ??= new Map());

  if (rows.has(key)) return rows.get(key) as T;

  const value = await load();

  rows.set(key, value);

  return value;
}

/**
 * Forgets everything this request had remembered.
 *
 * Coarse on purpose: forgetting one key would still leave a stale copy behind
 * when the write touched a relation the cached object carries — a profile's
 * permissions, a business's entitlements. The map holds a handful of entries
 * for the life of one request, so throwing it away costs nothing and cannot
 * be subtly wrong.
 */
function forgetRequestCache(): void {
  getRequestContext()?.rows?.clear();
}

/**
 * Runs something with no request scope at all.
 *
 * `enterWith` binds the store to the remainder of the current asynchronous
 * branch, which is what makes it work in a Fastify hook — but it also means a
 * branch that entered one keeps it. Anything that deliberately outlives the
 * request it was started from should not inherit its memory.
 */
function withoutRequestContext<T>(run: () => T): T {
  return storage.exit(run);
}

/** For tests: how many rows the current request is holding. */
function requestCacheSize(): number {
  return getRequestContext()?.rows?.size ?? 0;
}

export {
  endRequestContext,
  enterRequestContext,
  forgetRequestCache,
  getRequestContext,
  remember,
  requestCacheSize,
  withoutRequestContext,
};
export type { RequestContext };
