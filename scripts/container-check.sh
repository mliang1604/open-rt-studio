#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Checks the server's container as compose.yaml runs it: built, healthy,
# closed to whoever has not logged in, open to an account made by its
# command, not root, and with its data kept across a restart; and then as
# compose.https.yaml runs it, over HTTPS with a certificate made here. Run by
# CI (the "Container" job) and by anyone with Docker and OpenSSL, from the
# repository root:
#
#   scripts/container-check.sh
#
# It starts the compose project, and removes it with its volume when done.

set -euo pipefail

address="http://127.0.0.1:${OPEN_RT_STUDIO_PUBLISHED_PORT:-4300}"
name="check-admin"
# Made here, used here, gone with the volume.
password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
# Where the certificate for the second half is made, and removed from.
certs=""

finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- the server's log ---"
    docker compose logs --no-color server || true
  fi
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  [ -z "$certs" ] || rm -rf "$certs"
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

# A dependency publishes sample DICOM files with its tests; the Dockerfile takes them out.
[ -z "$(docker compose exec -T server find /app -name '*.dcm' -print -quit)" ] ||
  fail "the image has a DICOM file in it"
say "the image has no DICOM file in it"

# The DIMSE library loads in the image, which leaves out a package it names
# and never uses: an echo to a port nothing listens on says that nothing
# answered, and does not fail to start.
echoed="$(docker compose run --rm -T server dicom-echo 127.0.0.1 9 NOBODY 2>&1 || true)"
# Compose writes what it is doing to the same place as the command's answer.
printf '%s\n' "$echoed" | grep --quiet --fixed-strings --line-regexp \
  'No DICOM system answered at 127.0.0.1:9.' ||
  fail "the echo command did not run in the image: $echoed"
say "the DICOM library runs in the image"

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

# Over HTTPS (#57): the same server and the same data, with compose.https.yaml
# and a certificate made here for this address. Its key is used here and
# removed with the directory; the container's user is not this one, so both
# files are left readable, which a key that guards anything must not be.
secure="https://127.0.0.1:${OPEN_RT_STUDIO_PUBLISHED_PORT:-4300}"
certs="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$certs/key.pem" -out "$certs/cert.pem" >/dev/null 2>&1 ||
  fail "no certificate could be made for the check over HTTPS"
chmod 755 "$certs"
chmod 644 "$certs/cert.pem" "$certs/key.pem"
export OPEN_RT_STUDIO_CERT_DIR="$certs"
docker compose --file compose.yaml --file compose.https.yaml up --detach --wait
say "with a certificate, the server starts and reports itself healthy"

trusting=(--cacert "$certs/cert.pem")
[ "$(curl --silent --fail "${trusting[@]}" "$secure/health" |
  sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')" = ok ] ||
  fail "the health endpoint does not answer over HTTPS"
say "the health endpoint answers over HTTPS, to a client that trusts the certificate"

# curl ends with 60 for a certificate it cannot verify.
unverified=0
curl --silent --output /dev/null "$secure/health" || unverified=$?
[ "$unverified" = 60 ] || fail "a client that was not given the certificate was answered ($unverified)"
say "a client that was not given the certificate does not trust the server"

plain=0
curl --silent --output /dev/null --max-time 10 "$address/health" || plain=$?
[ "$plain" != 0 ] || fail "the server answered plain HTTP on the port it speaks HTTPS on"
say "plain HTTP is not answered on that port"

[ "$(status_of "${trusting[@]}" "$secure/api/v1/patients")" = 401 ] ||
  fail "the server answered someone who had not logged in, over HTTPS"
token="$(curl --silent --fail "${trusting[@]}" --request POST \
  --header 'Content-Type: application/json' \
  --data "{\"name\":\"$name\",\"password\":\"$password\"}" "$secure/api/v1/session" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
[ -n "$token" ] || fail "the account could not log in over HTTPS"
[ "$(status_of "${trusting[@]}" --header "Authorization: Bearer $token" \
  "$secure/api/v1/patients")" = 200 ] ||
  fail "a logged-in administrator was not answered over HTTPS"
say "the API is reached over HTTPS: closed without a login, and open with one"

docker compose --file compose.yaml --file compose.https.yaml stop --timeout 20 server
[ "$(docker compose --file compose.yaml --file compose.https.yaml ps --all \
  --format '{{.ExitCode}}' server)" = 0 ] ||
  fail "the server with a certificate did not stop cleanly when asked"
say "the server with a certificate stops cleanly"

echo "The container is as it should be."
