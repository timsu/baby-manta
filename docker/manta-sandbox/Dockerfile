# manta-sandbox — the cloud worker venue image.
#
# Built ON the base-sandbox image (a ready coding box: ubuntu 24.04 +
# mise-pinned node 24 / pnpm / bun + gh + git + ripgrep + build toolchain +
# postgres). That base is platform-specific but a proven shortcut — we don't
# rebuild a full dev environment, we just clone the Manta worker-daemon on top.
#
# REFRESH MODEL: this image is rebuilt only PERIODICALLY (weekly / on dep
# changes), NOT per manta merge. The baked /opt/manta clone is refreshed at
# sandbox boot — start-sandbox-worker does `git pull` first — so a box always
# runs current daemon code without a per-merge image rebuild.
#
# Inside the box the daemon runs in single-task mode: the server injects
# MANTA_SANDBOX_TOKEN / MANTA_TASK / MANTA_TASK_MESSAGE / MANTA_SERVER_URL at
# create, vends ~/.git-credentials (manta-repo + task-repo App tokens, path-
# matched), then launches start-sandbox-worker. The daemon dials back to
# /worker-ws and self-starts the task — same code as the laptop venue.
#
# Build context = repo root. Needs a GitHub token (read access to the manta repo)
# as a BuildKit secret to clone it:
#   DOCKER_BUILDKIT=1 docker build \
#     --secret id=gh_token,src=<(gh auth token) \
#     --build-arg BASE_IMAGE=<acct>.dkr.ecr.us-east-2.amazonaws.com/base-sandbox:<tag> \
#     -f docker/manta-sandbox/Dockerfile -t manta-sandbox .
#
# Then push to the manta-sandbox ECR repo and register a Daytona snapshot (see
# register-snapshot.sh), and set MANTA_SANDBOX_SNAPSHOT on the server.

ARG BASE_IMAGE=<aws-account-id>.dkr.ecr.<region>.amazonaws.com/base-sandbox:latest
FROM ${BASE_IMAGE}

# The manta source repo to clone (org/repo). Must be one of the server's
# MANTA_SANDBOX_SEED_REPOS so it vends a pull token for it (default maps
# acme/manta=/opt/manta).
ARG MANTA_REPO=acme/manta
ARG MANTA_REF=main

# Build as the base image's configured user (ubuntu) so mise-managed node/pnpm
# are on PATH and the build matches the runtime user. /opt/manta is created
# root-owned, so hand it to ubuntu first.
USER root
# Common interactive CLI tools the minimal the sandbox service base omits, so a human
# dropping into the box's terminal isn't stuck without an editor or pager. The
# agent mostly uses built-in tools, but people poke around by hand. Best-effort
# layer: keep it small and don't fail the build if a package is unavailable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends vim nano less tree jq ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 || echo "warning: optional CLI tools install skipped"
RUN install -d -o ubuntu -g ubuntu /opt/manta
USER ubuntu
ENV HOME=/home/ubuntu
WORKDIR /opt/manta

# The base ships node 24.16 via mise but only selects it inside the platform repo
# dir (its .tool-versions); set a global default so node/corepack/pnpm resolve in
# /opt/manta at build AND at runtime (start-sandbox-worker, also run as ubuntu).
RUN mise use -g node@24.16.0 \
 && corepack enable \
 && corepack prepare pnpm@10.28.2 --activate

# Clone manta with a build-time token (BuildKit secret; uid=1000 so ubuntu can
# read it), then strip the token from the remote so the runtime `git pull` uses
# the vended ~/.git-credentials (matched per repo path). A blobless clone keeps
# the image small but still supports `git pull` at boot.
RUN --mount=type=secret,id=gh_token,required=true,uid=1000 \
    GH_TOKEN="$(cat /run/secrets/gh_token)" \
 && git clone --filter=blob:none --branch "${MANTA_REF}" \
      "https://x-access-token:${GH_TOKEN}@github.com/${MANTA_REPO}.git" . \
 && git remote set-url origin "https://github.com/${MANTA_REPO}.git"

# Only the worker-daemon + its workspace deps (@manta/agent, @manta/shared) —
# NOT @manta/db, which the daemon never imports (no DB access in a sandbox). So
# there's no prisma client to generate here.
RUN pnpm install --frozen-lockfile --filter "@manta/worker-daemon..."

# Launcher + git config + sentinel credential file. The server overwrites the
# sentinel ~/.git-credentials with real tokens before the daemon starts.
COPY --chown=ubuntu:ubuntu docker/manta-sandbox/start-sandbox-worker /opt/manta/start-sandbox-worker
COPY --chown=ubuntu:ubuntu docker/manta-sandbox/gitconfig /home/ubuntu/.gitconfig
# The pi SDK reads auth from ~/.pi/agent/auth.json (getAgentDir()); the server
# vends the workspace's real credentials there at launch.
RUN chmod +x /opt/manta/start-sandbox-worker \
 && mkdir -p /home/ubuntu/.pi/agent /home/ubuntu/.manta \
 && printf '{}' > /home/ubuntu/.pi/agent/auth.json \
 && touch /home/ubuntu/.git-credentials

# The control plane keeps the box alive and drives the daemon launch via
# streamLogs (cf. the sandbox service's service-driven job-entry.sh). Keep-alive entrypoint.
ENTRYPOINT ["sleep", "infinity"]
