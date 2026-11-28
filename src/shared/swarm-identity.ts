import { env } from "@/env";

/**
 * Which node, slot and service this process is in the Swarm (plano-escala
 * F4-50), from SWARM_NODE_HOSTNAME, SWARM_TASK_SLOT and SWARM_SERVICE_NAME,
 * which the Application's Environment sets to the Swarm's own templates.
 *
 * The container's hostname is all a log line or an ops_sample row said about
 * where it ran: a container id that changes on every deploy and names no
 * machine. With a second node (F4-52), "the slow replica" has to name the
 * node; the slot ties one replica's series across deploys.
 *
 * The env schema already dropped a template nobody rendered, an empty value
 * and anything that is not a plain name, so a part is either a name or
 * missing. Unset, the identity is empty and nothing anywhere changes. Not a
 * secret: it names a machine and a service, never how to reach them.
 *
 * The node's column in a table (process_heartbeat) arrives with F3-03, not in
 * worker_heartbeat.
 */
interface SwarmIdentity {
  /** `{{.Node.Hostname}}`: the machine the task runs on. */
  node?: string;

  /** `{{.Task.Slot}}`: 1..N; a global service renders the node id instead. */
  task_slot?: string;

  /** `{{.Service.Name}}`: the Application's App Name. */
  service?: string;
}

interface SwarmIdentitySource {
  SWARM_NODE_HOSTNAME?: string;
  SWARM_TASK_SLOT?: string;
  SWARM_SERVICE_NAME?: string;
}

/** Only the parts that are present: an absent part is no key at all. */
function swarmIdentityOf(source: SwarmIdentitySource): Readonly<SwarmIdentity> {
  const identity: SwarmIdentity = {};

  if (source.SWARM_NODE_HOSTNAME) identity.node = source.SWARM_NODE_HOSTNAME;
  if (source.SWARM_TASK_SLOT) identity.task_slot = source.SWARM_TASK_SLOT;
  if (source.SWARM_SERVICE_NAME) identity.service = source.SWARM_SERVICE_NAME;

  return Object.freeze(identity);
}

/**
 * The logger's extra bindings: `swarm_*`, beside pino's own `hostname`, and
 * only for the parts that are present, so a line without the variables is
 * byte for byte what it was.
 */
function swarmLogBindings(
  identity: Readonly<SwarmIdentity>,
): Record<string, string> {
  const bindings: Record<string, string> = {};

  if (identity.node) bindings.swarm_node = identity.node;
  if (identity.task_slot) bindings.swarm_task_slot = identity.task_slot;
  if (identity.service) bindings.swarm_service = identity.service;

  return bindings;
}

/** This process's identity, read once at import like the build info. */
const swarmIdentity: Readonly<SwarmIdentity> = swarmIdentityOf(env);

export { swarmIdentity, swarmIdentityOf, swarmLogBindings };
export type { SwarmIdentity };
