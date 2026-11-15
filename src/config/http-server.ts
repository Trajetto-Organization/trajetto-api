import type { onSendHookHandler } from "fastify";

import { isDraining } from "@/shared/lifecycle/draining";

/**
 * How long a client may take to SEND one whole request: headers and body.
 *
 * Fastify's default is 0, and Fastify writes that 0 over Node's own 300 s
 * cap, so the body phase had no time limit at all (headersTimeout covers only
 * the headers). A POST dripping one byte every few seconds held its socket,
 * and on a public route its buffer, for as long as the sender liked — and a
 * 429 from the rate limiter does not close the connection while the body is
 * still arriving.
 *
 * 120 s because that is how long the app build in drivers' hands waits for
 * an upload (UPLOAD_TIMEOUT_MS in trajetto-mobile's utils/api.ts on main), and
 * that build still posts fuelings and checklists as multipart with up to 5 MB
 * of photos. Cloudflare does NOT hold the body back: its default buffering
 * inspects a prefix and streams the rest, so the origin receives at the
 * phone's pace. A shorter cap would refuse uploads the phone was still
 * willing to finish. It bounds RECEIVING the request, not the handler's work,
 * and upgraded websockets are not affected.
 *
 * Keep it >= Node's headersTimeout (60 s): when headersTimeout is the larger
 * one, Node swaps the two and the body gets the headers' budget instead.
 */
const HTTP_REQUEST_TIMEOUT_MS = 120_000;

/**
 * How long an idle keep-alive connection stays open on OUR side.
 *
 * Longer than the proxy's: Traefik keeps idle connections to a replica for 90 s
 * (serversTransport idleConnTimeout, its default; neither the Dokploy stack nor
 * infra/traefik changes it), and Fastify's default here is 72 s. With ours
 * shorter, the replica is the one that closes, and a request Traefik writes on
 * that connection at the same moment is lost: Go retries a GET on a fresh
 * connection, but not a POST, so the client gets a 502. Under load it is worse:
 * a busy event loop runs the overdue keep-alive timer BEFORE reading the
 * request already waiting on the socket. Measured in the load harness: 16 POST
 * /route/positions answered 502 in one stress run (the load of 07/10/2026,
 * docs/desempenho/README.md). Above 90 s, Traefik always closes first.
 */
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 95_000;

/**
 * How many requests one keep-alive connection serves before its response
 * says `Connection: close` (HTTP_MAX_REQUESTS_PER_SOCKET; Node's
 * server.maxRequestsPerSocket, plano-escala F1-15).
 *
 * The Swarm spreads CONNECTIONS across replicas, not requests, and with the
 * keep-alive above a busy connection never goes idle: after a scale-up the
 * replicas already up kept every connection Traefik had, and the new one sat
 * almost empty. With the cap, each connection is renewed every thousand
 * requests — a few seconds under load, minutes when quiet — and the Swarm
 * may hand the new one to any replica. The response that says close is the
 * last one on that connection, and the client knows it before sending
 * another, so no request is caught by the close. 0 turns it off (the
 * rollback).
 */
const HTTP_MAX_REQUESTS_PER_SOCKET_DEFAULT = 1_000;

/**
 * While the replica drains, every response says `Connection: close`, and
 * Node ends that connection once it is sent (plano-escala F1-15).
 *
 * The Swarm takes a stopping task out of the service's address before the
 * SIGTERM, so new connections already go to another replica, but the
 * keep-alive ones Traefik holds with this task kept carrying requests until
 * the listener closed under them. Telling the client on a response is the
 * only close with no race: an idle connection closed by us (a
 * closeIdleConnections loop, say) can meet a POST Traefik is writing at that
 * moment, and Go never retries a POST — the user gets a 502. Idle ones are
 * left to Fastify's close at the end of the drain.
 */
const closeConnectionWhileDraining: onSendHookHandler = (
  _request,
  reply,
  payload,
  done,
) => {
  if (isDraining()) reply.header("connection", "close");

  done(null, payload);
};

export {
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_MAX_REQUESTS_PER_SOCKET_DEFAULT,
  HTTP_REQUEST_TIMEOUT_MS,
  closeConnectionWhileDraining,
};
