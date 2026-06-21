# syntax=docker/dockerfile:1
#
# Build the extension release archive with Docker. The build logic lives in
# scripts/build.sh (compile TypeScript, copy assets, validate the manifest, then zip).
# This image provides a clean, reproducible environment (node + bash/zip/jq).
#
# Usage:
#   # Produce the zip into ./dist (recommended; also used by CI):
#   docker build --target export --output type=local,dest=dist .
#
#   # Or build an image containing the artifact and copy it out:
#   docker build -t shot2issue-build .
#   id=$(docker create shot2issue-build) && docker cp "$id":/dist ./dist && docker rm "$id"

# ---- Build stage: run build.sh; the artifact lands in /src/dist ----
FROM node:20-alpine AS build
RUN apk add --no-cache bash zip jq
WORKDIR /src
COPY . .
RUN bash scripts/build.sh

# ---- Export stage: a minimal image/artifact with just the zip, for --output ----
FROM scratch AS export
COPY --from=build /src/dist/ /
