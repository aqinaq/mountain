#!/bin/sh
# A freshly attached volume arrives owned by root, but the server runs as the
# unprivileged `node` user and has to write the SQLite database and the
# uploaded books. Fix ownership while we still have the privileges to do it,
# then hand the process over.
#
# lib/db.ts resolves its data directory from process.cwd(), and the workdir is
# /app — so this path is the one the volume has to be mounted on.
set -e

mkdir -p /app/data/files
chown -R node:node /app/data

exec su-exec node "$@"
