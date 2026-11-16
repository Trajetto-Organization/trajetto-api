# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# trajetto-postgres: the Database image of staging and production
# (plano-escala F1-01). The official postgres:16-alpine, byte for byte, plus
# pgBackRest compiled from source, the parameters production runs
# (trajetto-entrypoint.sh, postgres.params) and the backup and drill scripts.
#
#   docker build -t trajetto-postgres infra/postgres      the image (last stage)
#   docker build --target test infra/postgres             its tests, offline
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
# The base by digest (INFRA-16): postgres:16-alpine (16.15, Alpine 3.24), the
# same digest as validate.yml's services and staging.yml's smoke test; bumped
# with them, by hand (docs/deploy.md, "Versões fixas").
#
# pgBackRest's version and the SHA-256 of its source, in this one ARG: the
# primary, the future standby and the restore drill all run this image, so
# they can never disagree on it. 2.60.1 (16/11/2026): the first release with
# both the fix of weak encryption subkeys (2.59.3) and the one of the free
# list that let each process keep up to 64 MiB more (2.59.1 to 2.60.0), which
# would eat the memory reserve trajetto-entrypoint.sh keeps for it.
ARG PGBACKREST_VERSION=2.60.1 \
    PGBACKREST_SHA256=9a8aaf770e5e57c18426d5c2fa34e749db1ecb2d56979bf064550d5493a2df55

FROM postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab AS base

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
FROM base AS app

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
COPY --link postgres.params /etc/trajetto/postgres.params
COPY --link pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --link --chmod=0755 trajetto-entrypoint.sh /usr/local/bin/trajetto-entrypoint.sh

# conf.d holds runtime.conf, which the entrypoint rewrites at every start;
# the postgres user owns it so a container started as that user can too.
RUN install -d -o postgres -g postgres -m 0755 /etc/pgbackrest/conf.d

ENTRYPOINT ["trajetto-entrypoint.sh"]
CMD ["postgres"]

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
