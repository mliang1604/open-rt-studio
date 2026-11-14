#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Checks the server's container as compose.yaml runs it: built, healthy,
# closed to whoever has not logged in, open to an account made by its
# command, not root, and with its data kept across a restart. Run by CI (the
# "Container" job) and by anyone with Docker, from the repository root:
#
#   scripts/container-check.sh
#
# It starts the compose project, and removes it with its volume when done.

set -euo pipefail

address="http://127.0.0.1:${OPEN_RT_STUDIO_PUBLISHED_PORT:-4300}"
name="check-admin"
# Made here, used here, gone with the volume.
password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- the server's log ---"
    docker compose logs --no-color server || true
  fi
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

say() { echo "ok: $1"; }
fail() {
  echo "FAILED: $1" >&2
  exit 1
}
status_of() { curl --silent --output /dev/null --write-out '%{http_code}' "$@"; }
log_in() {
  curl --silent --fail --request POST --header 'Content-Type: application/json' \
    --data "{\"name\":\"$name\",\"password\":\"$password\"}" "$address/api/v1/session" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

# Built and started; --wait returns once the image's own health check passes.
docker compose up --build --detach --wait
say "the image builds, and the server in it reports itself healthy"

[ "$(curl --silent --fail "$address/health" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')" = ok ] ||
  fail "the health endpoint does not answer ok"
say "the health endpoint answers from outside the container"

[ "$(status_of "$address/api/v1/patients")" = 401 ] ||
  fail "the server answered someone who had not logged in"
say "nothing is answered without a login"

[ "$(docker compose exec -T server id -u)" != 0 ] || fail "the server runs as root"
say "the server does not run as root"

# The first account, as the README says to make it: the password on standard input.
printf '%s\n' "$password" | docker compose run --rm -T server account add "$name" --admin
token="$(log_in || true)"
[ -n "$token" ] || fail "the account made by the command could not log in"
[ "$(status_of --header "Authorization: Bearer $token" "$address/api/v1/patients")" = 200 ] ||
  fail "a logged-in administrator was not answered"
say "an account made by the account command logs in and is answered"

# What the server keeps is in the volume: a new container finds the account.
docker compose down >/dev/null 2>&1
docker compose up --detach --wait
token="$(log_in || true)"
[ -n "$token" ] || fail "the account was gone after the container was replaced"
[ "$(status_of --header "Authorization: Bearer $token" "$address/api/v1/audit")" = 200 ] ||
  fail "the audit log was not there after the container was replaced"
say "accounts and the audit log are kept across a new container"

# A clean stop: the server ends by itself when asked, within the time Docker gives it.
docker compose stop --timeout 20 server
[ "$(docker compose ps --all --format '{{.ExitCode}}' server)" = 0 ] ||
  fail "the server did not stop cleanly when asked"
say "the server stops cleanly when the container is stopped"

echo "The container is as it should be."
