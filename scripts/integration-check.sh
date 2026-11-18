#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Checks the server as it is deployed, end to end (#59): its container with
# its index in PostgreSQL (compose.postgres.yaml), spoken to over HTTP and
# over DICOM by two other systems: DCMTK's tools on this machine, and Orthanc
# in a container beside it (compose.integration.yaml). The scenarios are in
# services/server/src/integration.spec.ts; this starts what they need, runs
# them, and then checks that a new container finds everything again.
#
# Run by CI (the "Integration" job) and by anyone with Docker, DCMTK and the
# repository's packages installed (npm ci), from the repository root:
#
#   scripts/integration-check.sh
#
# DCMTK and Orthanc are test peers here: neither is bundled with the server
# or linked into it. Everything it stores is generated, synthetic data. It
# starts the compose project, and removes it with its volumes when done.

set -euo pipefail

compose=(docker compose --file compose.yaml --file compose.postgres.yaml --file compose.integration.yaml)
address="http://127.0.0.1:${OPEN_RT_STUDIO_PUBLISHED_PORT:-4300}"
name="integration-admin"
random() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'; }
# Made here, used here, gone with the volumes.
password="$(random)"
OPEN_RT_STUDIO_DATABASE_PASSWORD="$(random)"
export OPEN_RT_STUDIO_DATABASE_PASSWORD

finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for service in server postgres orthanc; do
      echo "--- the log of $service ---"
      "${compose[@]}" logs --no-color --tail 200 "$service" || true
    done
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

say() { echo "ok: $1"; }
fail() {
  echo "FAILED: $1" >&2
  exit 1
}
log_in() {
  curl --silent --fail --request POST --header 'Content-Type: application/json' \
    --data "{\"name\":\"$name\",\"password\":\"$password\"}" "$address/api/v1/session" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}
# How many instances the server says it holds.
instances() {
  curl --silent --fail --header "Authorization: Bearer $1" "$address/api/v1/counts" |
    sed -n 's/.*"instances":\([0-9]*\).*/\1/p'
}

for tool in echoscu storescu findscu; do
  command -v "$tool" >/dev/null || fail "DCMTK's $tool is not installed"
done

# Built and started; --wait returns once the server and PostgreSQL say they are healthy.
"${compose[@]}" up --build --detach --wait
say "the server, PostgreSQL and Orthanc start, and the server reports itself healthy"

"${compose[@]}" logs --no-color server |
  grep --quiet --fixed-strings '"event":"index-opened","backend":"postgresql"' ||
  fail "the server did not open its index in PostgreSQL"
say "the server's index is in PostgreSQL"

# A port that is published is listed as "address:port->5432/tcp"; one that is not, as "5432/tcp".
case "$("${compose[@]}" ps --format '{{.Ports}}' postgres)" in
*'->'*) fail "PostgreSQL has a port on this machine" ;;
esac
say "PostgreSQL is reached by the server only"

printf '%s\n' "$password" | "${compose[@]}" run --rm -T server account add "$name" --admin
say "the first account is made by the account command"

(
  cd services/server
  OPEN_RT_STUDIO_INTEGRATION=1 INTEGRATION_SERVER="$address" \
    INTEGRATION_ADMIN="$name" INTEGRATION_PASSWORD="$password" \
    npx vitest run src/integration.spec.ts
)
say "the scenarios over HTTP and DICOM pass, against DCMTK and Orthanc"

# What the server holds is in the two volumes: new containers find it all.
token="$(log_in || true)"
[ -n "$token" ] || fail "the administrator could not log in after the scenarios"
before="$(instances "$token")"
[ "${before:-0}" -gt 0 ] || fail "the server holds nothing after the scenarios"
"${compose[@]}" down >/dev/null 2>&1
"${compose[@]}" up --detach --wait
token="$(log_in || true)"
[ -n "$token" ] || fail "the account was gone after the containers were replaced"
after="$(instances "$token")"
[ "$after" = "$before" ] || fail "the server held $before instances and holds ${after:-none} after new containers"
say "the $before instances, the index and the account are kept across new containers"

# The DICOM settings were made through the API; they are kept too, and the listener is on again.
echoscu --aetitle RUNNER --call OPENRTSTUDIO 127.0.0.1 11112 ||
  fail "the DICOM listener did not come back as it was set"
say "the DICOM listener comes back as it was set"

"${compose[@]}" stop --timeout 20 server
[ "$("${compose[@]}" ps --all --format '{{.ExitCode}}' server)" = 0 ] ||
  fail "the server did not stop cleanly when asked"
say "the server stops cleanly when the container is stopped"
