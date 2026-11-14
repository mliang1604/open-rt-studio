# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The Open RT Studio server as a container image. Not for clinical use.
#
# Built from the repository root:
#   docker build -f services/server/Dockerfile -t open-rt-studio-server .
#
# The image holds the built server, the DICOM package it uses, and what the
# two need to run: no compiler, no tests, no viewer. See
# services/server/README.md ("In a container") for how to run it.

ARG NODE_VERSION=24

# --- Build: the compiler, and what the two packages need to be compiled. ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
# The manifests first, so that the install is cached until one of them changes.
COPY package.json package-lock.json ./
COPY packages/dicom/package.json packages/dicom/
COPY packages/render/package.json packages/render/
COPY packages/testdata/package.json packages/testdata/
COPY services/server/package.json services/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# Every workspace's manifest is there for the lockfile to be read; only the
# server's and the DICOM package's dependencies are installed, and the root's
# (the compiler). The viewer's are not: no Angular, no browser.
RUN npm ci --workspace @open-rt-studio/server --workspace @open-rt-studio/dicom \
      --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/dicom packages/dicom
COPY services/server services/server
# The server's build builds the DICOM package it refers to as well.
RUN npm run build -w @open-rt-studio/server

# --- What runs: only what the lockfile says the server needs. ---------------
FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/dicom/package.json packages/dicom/
COPY packages/render/package.json packages/render/
COPY packages/testdata/package.json packages/testdata/
COPY services/server/package.json services/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev --workspace @open-rt-studio/server --ignore-scripts --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/package.json ./
COPY --from=dependencies /app/node_modules node_modules
COPY --from=dependencies /app/packages/dicom/package.json packages/dicom/
COPY --from=dependencies /app/services/server/package.json services/server/
COPY --from=build /src/packages/dicom/dist packages/dicom/dist
COPY --from=build /src/services/server/dist services/server/dist
COPY LICENSE ./

# What the server keeps: instances, the index, accounts and the audit log.
# Owned by the user the server runs as, which is not root.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node

# In a container the server listens on every address of the container; which
# addresses of the machine reach it is for whoever publishes the port to say.
# It asks for a login (the default), which it insists on for such an address.
ENV OPEN_RT_STUDIO_HOST=0.0.0.0 \
    OPEN_RT_STUDIO_PORT=4300 \
    OPEN_RT_STUDIO_DATA_DIR=/data
EXPOSE 4300

# The server's own `health` command: over HTTPS when the server was given a
# certificate. It asks whether the server answers, not whose certificate it is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=3 \
  CMD ["node", "services/server/dist/main.js", "health"]

# `docker run IMAGE` starts the server; `docker run -it IMAGE account add NAME
# --admin` is its account command, on the same data.
ENTRYPOINT ["node", "services/server/dist/main.js"]
