# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# trajetto-postgres: the Database image of staging and production
# (plano-escala F1-01). The official postgres:16-alpine, its server byte for
# byte, plus pgBackRest compiled from source, its gosu rebuilt with a fixed
# Go (below), the parameters production runs (trajetto-entrypoint.sh,
# postgres.params), a versioned pg_hba.conf, the standby branch
# (plano-escala F4-40) and the backup and drill scripts.
#
#   docker build -t trajetto-postgres infra/postgres      the image (last stage)
#   docker build --target test infra/postgres             its tests, offline
#   docker build --target wrapper infra/postgres          no pgBackRest (E2E)
#
# A drop-in for the volume of today's Database: the same base by digest (the
# one validate.yml's E2E runs), so the same PostgreSQL 16 binaries, the same
# musl and the same libc collation; the base's packages are checked to keep
# their versions below. Swapping it on a physical copy of the cluster needs
# nothing else (docs: the swap of the Database image, plano-escala 3.6).
#
# No `apk add pgbackrest`: the package depends on `postgresql`, a second
# server (18 on Alpine 3.24) beside the image's own 16. The builder compiles
# it against the image's own libpq, and the image ships the binary alone.
#
# The base by digest (INFRA-16): postgres:16-alpine (16.16, Alpine 3.24.4,
# the index of 18/11/2026), the same digest as validate.yml's services,
# staging.yml's smoke test and trajetto-ui's validate.yml; bumped with them,
# by hand, all at once (docs/deploy.md, "Versões fixas"). A minor bump keeps
# the volume: the same major and the same musl collation.
#
# pgBackRest's version and the SHA-256 of its source, in this one ARG: the
# primary, the future standby and the restore drill all run this image, so
# they can never disagree on it. 2.60.1 (16/11/2026): the first release with
# both the fix of weak encryption subkeys (2.59.3) and the one of the free
# list that let each process keep up to 64 MiB more (2.59.1 to 2.60.0), which
# would eat the memory reserve trajetto-entrypoint.sh keeps for it.
ARG PGBACKREST_VERSION=2.60.1 \
    PGBACKREST_SHA256=9a8aaf770e5e57c18426d5c2fa34e749db1ecb2d56979bf064550d5493a2df55

# gosu's version and the SHA-256 of its source, in one ARG as pgBackRest's.
# 1.20 is the release the base ships (the first with the fix of
# GO-2026-6686 in github.com/moby/sys/user): the same source, another Go.
ARG GOSU_VERSION=1.20 \
    GOSU_SHA256=207a2045e890d3ca3326027c5f585733085960b401a49dbc00e3bb628c054cf8

# --- gosu, rebuilt with a fixed Go ---------------------------------------------
# The base's /usr/local/bin/gosu (the official entrypoint steps down to the
# postgres user with it; so do trajetto-backup and the drill) is upstream's
# release binary, built with Go 1.24.6: the image scan of staging.yml flags
# its stdlib with CVE-2025-68121 (crypto/tls session resumption, CRITICAL,
# fixed in Go 1.24.13 and 1.25.7) and two dozen HIGHs. gosu never links
# crypto/tls, and upstream does not rebuild for a CVE in code it does not
# call (its SECURITY.md); but no official postgres:16-alpine has a newer
# toolchain either (the base's digest of 18/11/2026, 16.16, ships gosu 1.20
# still built with Go 1.24.6), and a finding waved through by hand would
# hide the next real one. So upstream's release source, checked by its SHA-256,
# built the way upstream builds it (static, no cgo, `-trimpath -ldflags
# '-d -w'`) with the Go of this builder, pinned by digest; bumped by hand,
# like the base.
# su-exec would be a smaller swap, but every caller here and the official
# entrypoint run `gosu` by name, with its own argument rules.
FROM golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS gosu
ARG GOSU_VERSION GOSU_SHA256
# The modules come from the Go proxy, each checked against gosu's own
# go.sum and the checksum database; the compile itself has no network.
RUN set -eu; \
    wget -q -O /tmp/gosu.tar.gz \
      "https://github.com/tianon/gosu/archive/refs/tags/${GOSU_VERSION}.tar.gz"; \
    echo "${GOSU_SHA256}  /tmp/gosu.tar.gz" | sha256sum -c -; \
    mkdir /src; \
    tar -xzf /tmp/gosu.tar.gz -C /src --strip-components=1; \
    rm /tmp/gosu.tar.gz; \
    cd /src; \
    GOTOOLCHAIN=local go mod download; \
    GOTOOLCHAIN=local go mod verify
RUN --network=none set -eu; \
    cd /src; \
    CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -buildvcs=false \
      -ldflags '-d -w' -o /out/usr/local/bin/gosu .; \
    chmod 0755 /out/usr/local/bin/gosu; \
    test "$(/out/usr/local/bin/gosu --version)" = "${GOSU_VERSION} ($(go env GOVERSION) on linux/$(go env GOARCH); gc)"; \
    /out/usr/local/bin/gosu nobody true

FROM postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d AS base

# --- wrapper: the official server started the way this image starts it ------
# The parameters, pg_hba (the official rules plus one replication line for
# POSTGRES_REPLICATION_CIDR) and the standby branch, without pgBackRest:
# none of them needs it. The E2E infra phase runs this stage
# (tests/E2E/infra/run.sh builds --target wrapper in seconds), so its
# primary and its standby start exactly as the Database does.
FROM base AS wrapper
COPY --link postgres.params /etc/trajetto/postgres.params
COPY --link pg_hba.conf /etc/trajetto/pg_hba.conf
COPY --link --chmod=0755 trajetto-entrypoint.sh /usr/local/bin/trajetto-entrypoint.sh
# run/ holds what the entrypoint writes at every start (the pg_hba.conf
# hba_file points at, the standby's passfile); the postgres user owns it
# so a container started as that user can write them too.
RUN install -d -o postgres -g postgres -m 0755 /etc/trajetto/run
ENTRYPOINT ["trajetto-entrypoint.sh"]
CMD ["postgres"]

# --- pgBackRest, from source ---------------------------------------------------
# meson against the image's libpq (/usr/local). The source is the GitHub
# archive of the release tag, checked against the SHA-256 above before it is
# unpacked; the compile itself has no network. SFTP and systemd are left out
# (nothing here uses them, and each would be one more library to ship).
FROM base AS pgbackrest
ARG PGBACKREST_VERSION PGBACKREST_SHA256
RUN apk add --no-cache build-base meson samurai pkgconf python3 py3-yaml \
      openssl-dev lz4-dev zstd-dev bzip2-dev libxml2-dev zlib-dev
RUN set -eu; \
    wget -q -O /tmp/pgbackrest.tar.gz \
      "https://github.com/pgbackrest/pgbackrest/archive/refs/tags/release/${PGBACKREST_VERSION}.tar.gz"; \
    echo "${PGBACKREST_SHA256}  /tmp/pgbackrest.tar.gz" | sha256sum -c -; \
    mkdir /src; \
    tar -xzf /tmp/pgbackrest.tar.gz -C /src --strip-components=1; \
    rm /tmp/pgbackrest.tar.gz
RUN --network=none set -eu; \
    cd /src; \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig meson setup /build \
      --buildtype=release -Dlibssh2=disabled -Dlibsystemd=disabled -Dlibzstd=enabled; \
    ninja -C /build; \
    install -D -m 0755 -s /build/src/pgbackrest /out/usr/local/bin/pgbackrest; \
    test "$(/out/usr/local/bin/pgbackrest version)" = "pgBackRest ${PGBACKREST_VERSION}"

# --- app: what the tests and the image both run -------------------------------
FROM wrapper AS app

# The one runtime library pgBackRest needs that the base lacks (libbz2; lz4,
# zstd, libxml2, zlib and OpenSSL are the server's own). Adding it must not
# move any package of the base: a newer icu or musl here would be a
# different server than the one that wrote the volume. The build fails if
# any version changed.
RUN set -eu; \
    apk info -v 2> /dev/null | sort > /tmp/apk-before; \
    apk add --no-cache libbz2; \
    apk info -v 2> /dev/null | sort > /tmp/apk-after; \
    changed="$(comm -23 /tmp/apk-before /tmp/apk-after)"; \
    if [ -n "$changed" ]; then \
      echo "apk add mudou pacotes da base:"; echo "$changed"; exit 1; \
    fi; \
    rm /tmp/apk-before /tmp/apk-after

COPY --link --from=pgbackrest /out/ /
# The rebuilt gosu over the base's, at the same path and mode the official
# entrypoint runs. Here and not in the wrapper: the E2E infra phase builds
# that stage with no cache, and its step-down is the same gosu release
# (1.20, the base's) compiled by an older Go; what ships, and what the test
# stage starts as root, is this one.
COPY --link --from=gosu /out/ /
COPY --link pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
# The backup of the Schedule Jobs and the monthly drill (F1-02) ship with
# the server they back up: the same pgBackRest, no other copy to drift.
COPY --link --chmod=0755 bin/trajetto-backup bin/trajetto-restore-drill /usr/local/bin/

# conf.d holds runtime.conf, which the entrypoint rewrites at every start;
# the postgres user owns it so a container started as that user can too.
RUN install -d -o postgres -g postgres -m 0755 /etc/pgbackrest/conf.d

# --- tests: built by CI (`--target test`), never shipped -----------------------
# Offline: every server, backup and restore of test/run.sh is local.
FROM app AS test
ARG PGBACKREST_VERSION
COPY --link test/run.sh /usr/local/lib/trajetto-test/run.sh
RUN --network=none PGBACKREST_VERSION="${PGBACKREST_VERSION}" bash /usr/local/lib/trajetto-test/run.sh

# --- the image (the last stage: what a build without --target produces) -------
FROM app AS runtime

# The commit this image was built from (staging.yml passes GIT_SHA), which
# the entrypoint hands to the server as trajetto.image_revision (`SHOW
# trajetto.image_revision`). Declared LAST, after every RUN: it changes the
# image config only, never a layer. Empty in a local build ("dev").
ARG GIT_SHA=""
ENV APP_COMMIT_SHA=${GIT_SHA}
