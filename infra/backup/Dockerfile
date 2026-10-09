# The trajetto-backup service: a nightly, encrypted, off-host dump of the
# production database. See backup-to-r2.sh and docs/deploy.md (Backup e restauração).
#
# The postgres image, same major as production, because pg_dump must not be
# older than the server it dumps. Not pinned to production's exact digest:
# any 16.x client dumps any 16.x server. Pinned by digest for the build itself
# (INFRA-16): a tag can be re-pushed, a digest cannot; Dependabot moves it.
FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea

# rclone uploads to R2, age encrypts before anything leaves the container,
# curl pings the heartbeat.
RUN apk add --no-cache rclone age curl ca-certificates

# Line endings normalised: a Windows checkout can hand these over with CRLF,
# and `/bin/sh\r` is not an interpreter.
COPY backup-to-r2.sh /usr/local/bin/backup-to-r2
COPY backup-loop.sh /usr/local/bin/backup-loop
RUN sed -i 's/\r$//' /usr/local/bin/backup-to-r2 /usr/local/bin/backup-loop \
    && chmod 755 /usr/local/bin/backup-to-r2 /usr/local/bin/backup-loop

# Never root: the image's own unprivileged user. It needs nothing but /tmp.
USER postgres
WORKDIR /tmp

# Replaces the postgres entrypoint: this container never runs a server.
ENTRYPOINT ["/usr/local/bin/backup-loop"]
