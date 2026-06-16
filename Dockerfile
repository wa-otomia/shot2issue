# syntax=docker/dockerfile:1
#
# Build the extension release archive with Docker. The build logic lives in
# scripts/build.sh (validate the manifest, then zip). This image only provides a clean,
# reproducible environment (alpine + bash/zip/jq) with no heavyweight dependencies.
#
# Usage:
#   # Produce the zip into ./dist (recommended; also used by CI):
#   docker build --target export --output type=local,dest=dist .
#
#   # Or build an image containing the artifact and copy it out:
#   docker build -t shot2issue-build .
#   id=$(docker create shot2issue-build) && docker cp "$id":/dist ./dist && docker rm "$id"

# ---- Build stage: run build.sh; the artifact lands in /src/dist ----
FROM alpine:3.20 AS build
RUN apk add --no-cache bash zip unzip jq
WORKDIR /src
COPY . .
RUN bash scripts/build.sh

# ---- Export stage: a minimal image/artifact with just the zip, for --output ----
FROM scratch AS export
COPY --from=build /src/dist/ /
