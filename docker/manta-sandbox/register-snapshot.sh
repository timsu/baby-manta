#!/usr/bin/env bash
# Register (or refresh) the Daytona snapshot that the cloud worker venue boots
# from. Mirrors the platform's snapshot-registration script, but uses a
# STABLE snapshot name (default "manta-sandbox") and delete-then-create so the
# server's MANTA_SANDBOX_SNAPSHOT never has to change across periodic rebuilds.
# Sandboxes already running from the old snapshot are unaffected (a snapshot is
# only a creation template).
#
# Usage (env-driven):
#   DAYTONA_API_KEY=...                                  # required
#   DOCKER_IMAGE=<acct>.dkr.ecr.us-east-2.amazonaws.com/manta-sandbox:<tag> \
#   [SNAPSHOT_NAME=manta-sandbox] \
#     docker/manta-sandbox/register-snapshot.sh
set -euo pipefail

: "${DAYTONA_API_KEY:?DAYTONA_API_KEY required}"
: "${DOCKER_IMAGE:?DOCKER_IMAGE required}"

SNAPSHOT_NAME="${SNAPSHOT_NAME:-manta-sandbox}"
# Keep-alive entrypoint — the control plane launches the daemon via streamLogs.
ENTRYPOINT="${ENTRYPOINT:-sleep infinity}"
DAYTONA_CPU="${DAYTONA_CPU:-4}"
DAYTONA_MEMORY="${DAYTONA_MEMORY:-8}"
# 10GB is the per-sandbox max on our Daytona plan (create fails above it).
DAYTONA_DISK="${DAYTONA_DISK:-10}"

daytona login --api-key "$DAYTONA_API_KEY" >/dev/null

# Point the stable name at the new image: remove the old snapshot first, then
# create. `delete` is non-interactive (no --yes/--force flag exists); ignore its
# "not found" error on the very first run.
daytona snapshot delete "$SNAPSHOT_NAME" >/dev/null 2>&1 || true

daytona snapshot create "$SNAPSHOT_NAME" \
  --image "$DOCKER_IMAGE" \
  --entrypoint "$ENTRYPOINT" \
  --cpu "$DAYTONA_CPU" \
  --memory "$DAYTONA_MEMORY" \
  --disk "$DAYTONA_DISK"

echo "registered snapshot $SNAPSHOT_NAME -> $DOCKER_IMAGE"
