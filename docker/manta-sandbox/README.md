# manta-sandbox image

The cloud worker venue: an isolated Daytona sandbox that runs a task's coding
work. Built **on the base-sandbox image** (a ready ubuntu coding box with the
toolchain already installed — platform-specific, but a proven shortcut), with the
Manta worker-daemon layered on top.

## How the cloud venue works

1. `apps/server/src/worker/cloud.ts` mints a single-task token, creates a Daytona
   sandbox labelled `{ app=manta, workspace, task }`, and injects the task env.
2. It vends credentials into the box: the workspace's Pi `auth.json` (so the
   in-sandbox agent runs on the workspace subscription) and a GitHub App
   installation token in `~/.git-credentials` (so clone/push work; the PR is
   authored by the bot).
3. It launches `/opt/manta/start-sandbox-worker`, which runs the daemon in
   single-task mode. The daemon dials back to `/worker-ws`, registers with the
   single-task token, and self-starts the task — identical streaming/follow-up
   behaviour to the laptop venue.
4. The server manages lifecycle (idle-stop / resume / reconcile) around the box.

## Refresh model

The image is rebuilt **periodically** (weekly / on dependency changes), **not per
manta merge**. It bakes a clone of the manta repo at `/opt/manta`; at sandbox
boot, `start-sandbox-worker` runs `git pull --ff-only` (and reinstalls only if the
lockfile moved) so a box always runs current daemon code. The runtime pull
authenticates with a GitHub App token for the manta repo that the server vends
into `~/.git-credentials` (path-matched, alongside the task-repo token).

## Build

From the repo root, on the base-sandbox base, with a GitHub token (read access
to the manta repo) passed as a BuildKit secret to clone it:

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=gh_token,src=<(gh auth token) \
  --build-arg BASE_IMAGE=<aws-account-id>.dkr.ecr.<region>.amazonaws.com/base-sandbox:<tag> \
  -f docker/manta-sandbox/Dockerfile -t manta-sandbox .
```

Push to ECR (`manta-sandbox` repo in the labs account), then register a snapshot:

```bash
DAYTONA_API_KEY=… \
SNAPSHOT_NAME=manta-sandbox-<tag> \
DOCKER_IMAGE=<aws-account-id>.dkr.ecr.<region>.amazonaws.com/manta-sandbox:<tag> \
  docker/manta-sandbox/register-snapshot.sh
```

Finally set `MANTA_SANDBOX_SNAPSHOT=manta-sandbox-<tag>` on the server.

## Not yet wired (follow-ups)

- **Build pipeline**: a periodic CI job (weekly) to build/push the image and
  re-register the snapshot. The ECR repo + Daytona ECR-puller role live in the
  infrastructure repo (not included here).
- **`MANTA_SANDBOX_SNAPSHOT`**: set to the registered snapshot name in the task
  definition once the snapshot exists.
- **Credential heartbeat**: refresh the vended GitHub tokens (and rotated Pi auth)
  on a ~15-min cadence for long turns (the sandbox service's pattern). Currently vended once
  at create — fine for the boot pull + a normal turn, but a multi-hour turn could
  outlive the installation token's ~1h lifetime.

Node version is already settled: the the sandbox service base ships Node 24.16 (mise), which
the daemon's TS type-stripping needs.
