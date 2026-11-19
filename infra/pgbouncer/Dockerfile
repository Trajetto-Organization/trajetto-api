# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# trajetto-pgbouncer: the connection pooler in front of the Database
# (plano-escala F4-34, onda 17). PgBouncer compiled from source on Alpine,
# configured from the environment at every start (entrypoint.sh) and run as
# an unprivileged user.
#
#   docker build -t trajetto-pgbouncer infra/pgbouncer     the image (last stage)
#   docker build --target test infra/pgbouncer            its tests, offline
#
# From source, and not `apk add pgbouncer`: Alpine's package moves on
# Alpine's schedule, and the floor here is 1.26.1 (14/10/2026), the first
# release with all of these fixed:
#  - CVE-2026-107349: an empty option name in the startup `options` made
#    PgBouncer spin forever whenever ignore_startup_parameters is set
#    without `options`, which is exactly this configuration;
#  - CVE-2026-107350: a second StartupMessage during SCRAM let whoever
#    knows the password of an auth_file login (the console logins here)
#    log in as any SCRAM user, superusers included;
#  - CVE-2026-19888 and CVE-2026-6668 (1.26.0): a crash and a hang that an
#    unauthenticated client could cause.
# Never lower PGBOUNCER_VERSION below it.
#
# The base by digest: alpine:3.24.4, the Alpine line of postgres:16-alpine
# (the API's runtime stays on the line of its Node binary). Nothing here
# ties it to another image, so Dependabot moves it (.github/dependabot.yml);
# the PgBouncer version and its SHA-256 move by hand, together, from the
# release's own .sha256 file (www.pgbouncer.org/downloads).
ARG PGBOUNCER_VERSION=1.26.1 \
    PGBOUNCER_SHA256=00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS base

# --- PgBouncer, from source ------------------------------------------------------
# The release tarball (configure and man pages already generated), checked
# against the SHA-256 above before it is unpacked; the compile itself has no
# network. c-ares resolves the Database's name asynchronously and follows
# its TTL; PAM, LDAP and systemd stay out (nothing here uses them).
FROM base AS build
ARG PGBOUNCER_VERSION PGBOUNCER_SHA256
RUN apk add --no-cache build-base pkgconf libevent-dev openssl-dev c-ares-dev
RUN set -eu; \
    wget -q -O /tmp/pgbouncer.tar.gz \
      "https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz"; \
    echo "${PGBOUNCER_SHA256}  /tmp/pgbouncer.tar.gz" | sha256sum -c -; \
    mkdir /src; \
    tar -xzf /tmp/pgbouncer.tar.gz -C /src --strip-components=1; \
    rm /tmp/pgbouncer.tar.gz
RUN --network=none set -eu; \
    cd /src; \
    ./configure --prefix=/usr/local --with-cares --with-openssl; \
    make -j"$(nproc)" pgbouncer; \
    install -D -m 0755 -s pgbouncer /out/usr/local/bin/pgbouncer; \
    test "$(/out/usr/local/bin/pgbouncer --version | head -n 1)" = "PgBouncer ${PGBOUNCER_VERSION}"; \
    /out/usr/local/bin/pgbouncer --version | grep -q '^adns: c-ares'

# --- app: what the tests and the image both run -------------------------------------
FROM base AS app

# The libraries the binary links (libssl3 and libcrypto3 are the base's
# own), and psql with pg_isready: the HEALTHCHECK and the console (SHOW,
# PAUSE, RESUME) run inside the container. The client's major is the
# server's. The user has a fixed id and owns only the configuration
# directory, which only it can read (the auth_file holds passwords).
RUN set -eu; \
    apk add --no-cache libevent c-ares postgresql16-client; \
    addgroup -S -g 6432 pgbouncer; \
    adduser -S -D -u 6432 -G pgbouncer -h /var/lib/pgbouncer -s /sbin/nologin pgbouncer; \
    install -d -o pgbouncer -g pgbouncer -m 0700 /etc/pgbouncer

COPY --link --from=build /out/ /
COPY --link --chmod=0755 entrypoint.sh /usr/local/bin/trajetto-pgbouncer-entrypoint.sh

# A library the binary links and the image lacks fails the build here, not
# the first deploy.
RUN pgbouncer --version > /dev/null

USER pgbouncer
EXPOSE 6432

# PgBouncer itself, and never the Database behind it: the console database
# on the local port answers while the Database restarts (under PAUSE, or in
# a failover), and Swarm must not kill the endpoint every Application
# points at because Postgres is down. pg_isready needs no password: the
# authentication request PgBouncer sends back is the answer, and the
# entrypoint always lists pgbouncer_stats (with a password nobody holds
# when PGBOUNCER_STATS_PASSWORD is empty), so no check leaves a log line.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["pg_isready", "-q", "-h", "127.0.0.1", "-p", "6432", "-d", "pgbouncer", "-U", "pgbouncer_stats", "-t", "3"]

ENTRYPOINT ["trajetto-pgbouncer-entrypoint.sh"]
CMD ["pgbouncer"]

# --- tests: built by CI (`--target test`), never shipped ---------------------------
# Offline: PgBouncer and its console, on the container's own loopback.
FROM app AS test
ARG PGBOUNCER_VERSION
COPY --link test/run.sh /usr/local/lib/trajetto-test/run.sh
RUN --network=none PGBOUNCER_VERSION="${PGBOUNCER_VERSION}" sh /usr/local/lib/trajetto-test/run.sh

# --- the image (the last stage: what a build without --target produces) -------------
FROM app AS runtime

# The commit this image was built from (the CI passes GIT_SHA), which the
# entrypoint prints at every start. Declared LAST, after every RUN: it
# changes the image config only, never a layer. Empty in a local build.
ARG GIT_SHA=""
ENV APP_COMMIT_SHA=${GIT_SHA}
