# Nebius recorder setup

Status: **NOT RUN**. Every command below is a one-time setup command for Claude to run after this branch is reviewed. This build did not create, start, modify, or delete any cloud resource, secret, GitHub setting, or Vercel setting.

The workflow launches one short Serverless AI job at minute 23 of each hour. The job records the ten NWS points, rebuilds the current UTC day, updates `season/index.json` last, and exits. The workflow refuses to launch a job at or after `2026-12-16T00:00:00Z`.

## Sources checked

- CLI installation: https://docs.nebius.com/cli/install
- Service-account authorized keys and CLI profiles: https://docs.nebius.com/iam/service-accounts/authorized-keys
- Serverless AI job flags, timeout, restart policy, lifecycle, and same-project registry access: https://docs.nebius.com/serverless/jobs/manage
- SecretStash secrets and versions: https://docs.nebius.com/mysterybox/secrets/create
- Access key creation: https://docs.nebius.com/iam/service-accounts/access-keys
- CPU platforms and presets: https://docs.nebius.com/compute/virtual-machines/types
- Container Registry helper and image path: https://docs.nebius.com/container-registry/quickstart
- Object Storage S3 endpoint: https://docs.nebius.com/object-storage/s3-api
- Object Storage role actions: https://docs.nebius.com/object-storage/supported-actions

This tenant has projects in `eu-west2`, `us-north1` and `us-central1`, not `eu-north1`. On 2026-10-19 `nebius compute platform list` showed `cpu-d3` with `2vcpu-8gb` in all three, so the recorder runs in the `us-central1` project on `cpu-d3` / `2vcpu-8gb`. Serverless AI requires a minimum 20 GiB disk for CPU jobs. The job and the season route read the S3 signing region from the endpoint host, so the endpoint alone selects the region.

## Prerequisites

Run these commands in one WSL Ubuntu shell from `/mnt/c/dev/Nebius-NVIDIA-Global-AI/lh-recorder`. The first block enables fail-fast shell options for every later block. The Nebius installer supports Ubuntu and macOS, not Git Bash. Enable Docker Desktop's WSL integration and install `jq`, the AWS CLI, GitHub CLI, and Vercel CLI inside WSL. Use an already authenticated Nebius admin profile that can create IAM and project resources. Replace every angle-bracket value before running.

Install and verify the pinned CLI before setup:

```bash
set -euo pipefail
cd /mnt/c/dev/Nebius-NVIDIA-Global-AI/lh-recorder
curl --fail --silent --show-error --location \
  https://artifacts.nebius.cloud/cli/install.sh \
  --output /tmp/install-nebius.sh
NEBIUS_CLI_VERSION=0.12.283 bash /tmp/install-nebius.sh
export PATH="$HOME/.nebius/bin:$PATH"
nebius version --full
```

Confirm the reported version is `0.12.283`. Stop if it differs.

Create a temporary directory so credential files never enter the repository:

```bash
export PROJECT_ID='<project-id>'
export REGION_ID='us-central1'
export BUCKET_NAME='<globally-unique-labelhand-recorder-bucket>'
export SUBNET_ID='<existing-subnet-with-outbound-internet>'
export EXPECTED_VERCEL_PROJECT='<dedicated-labelhand-vercel-project-name>'
SETUP_DIR="$(mktemp -d)"
test -d "$SETUP_DIR"
export SETUP_DIR
export LAUNCHER_CREDENTIALS="$SETUP_DIR/launcher-credentials.json"
export WRITER_KEY_FILE="$SETUP_DIR/writer-access-key.json"
export READER_KEY_FILE="$SETUP_DIR/reader-access-key.json"
```

The selected subnet must reach `api.weather.gov`, `storage.$REGION_ID.nebius.cloud`, and the Nebius Container Registry. Confirm it before creating the first job.

## 1. Bucket

```bash
BUCKET_ID="$(nebius storage bucket create \
  --parent-id "$PROJECT_ID" \
  --name "$BUCKET_NAME" \
  --format jsonpath='{.metadata.id}')"
test -n "$BUCKET_ID"
export BUCKET_ID
```

## 2. GitHub Actions launcher identity

Serverless AI job creation currently requires the project-scoped `editor` role. Keep this identity separate from the bucket writer.

```bash
LAUNCHER_SA_ID="$(nebius iam service-account create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-recorder-launcher \
  --format jsonpath='{.metadata.id}')"
test -n "$LAUNCHER_SA_ID"
export LAUNCHER_SA_ID
LAUNCHER_GROUP_ID="$(nebius iam group create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-recorder-launchers \
  --format jsonpath='{.metadata.id}')"
test -n "$LAUNCHER_GROUP_ID"
export LAUNCHER_GROUP_ID
nebius iam access-permit create \
  --parent-id "$LAUNCHER_GROUP_ID" \
  --resource-id "$PROJECT_ID" \
  --role editor
nebius iam group-membership create \
  --parent-id "$LAUNCHER_GROUP_ID" \
  --member-id "$LAUNCHER_SA_ID"
nebius iam auth-public-key generate \
  --service-account-id "$LAUNCHER_SA_ID" \
  --expires-at 2026-12-17T00:00:00Z \
  --output "$LAUNCHER_CREDENTIALS"
test -s "$LAUNCHER_CREDENTIALS"
```

## 3. Bucket writer identity

The recorder needs list and read access to rebuild a day, plus put access for raw and compact objects. It does not need delete access.

```bash
WRITER_SA_ID="$(nebius iam service-account create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-recorder-writer \
  --format jsonpath='{.metadata.id}')"
test -n "$WRITER_SA_ID"
export WRITER_SA_ID
WRITER_GROUP_ID="$(nebius iam group create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-recorder-writers \
  --format jsonpath='{.metadata.id}')"
test -n "$WRITER_GROUP_ID"
export WRITER_GROUP_ID
nebius iam access-permit create \
  --parent-id "$WRITER_GROUP_ID" \
  --resource-id "$BUCKET_ID" \
  --role storage.viewer
nebius iam access-permit create \
  --parent-id "$WRITER_GROUP_ID" \
  --resource-id "$BUCKET_ID" \
  --role storage.uploader
nebius iam group-membership create \
  --parent-id "$WRITER_GROUP_ID" \
  --member-id "$WRITER_SA_ID"
nebius iam v2 access-key create \
  --parent-id "$PROJECT_ID" \
  --account-service-account-id "$WRITER_SA_ID" \
  --expires-at 2026-12-17T00:00:00Z \
  --description 'Labelhand recorder Object Storage writer' \
  --secret-delivery-mode inline \
  --format json > "$WRITER_KEY_FILE"
WRITER_ACCESS_KEY_ID="$(jq -er '.status.aws_access_key_id | select(type == "string" and length > 0)' "$WRITER_KEY_FILE")"
test -n "$WRITER_ACCESS_KEY_ID"
export WRITER_ACCESS_KEY_ID
WRITER_SECRET_ACCESS_KEY="$(jq -er '.status.secret | select(type == "string" and length > 0)' "$WRITER_KEY_FILE")"
test -n "$WRITER_SECRET_ACCESS_KEY"
export WRITER_SECRET_ACCESS_KEY
RECORDER_SECRET_PAYLOAD="$(jq -cn \
  --arg key_id "$WRITER_ACCESS_KEY_ID" \
  --arg secret "$WRITER_SECRET_ACCESS_KEY" \
  '[
    {"key":"AWS_ACCESS_KEY_ID","string_value":$key_id},
    {"key":"AWS_SECRET_ACCESS_KEY","string_value":$secret}
  ]')"
test -n "$RECORDER_SECRET_PAYLOAD"
RECORDER_SECRET_ID="$(nebius mysterybox secret create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-recorder-s3 \
  --description 'Labelhand recorder Object Storage credentials' \
  --secret-version-payload "$RECORDER_SECRET_PAYLOAD" \
  --secret-version-set-primary \
  --format jsonpath='{.metadata.id}')"
test -n "$RECORDER_SECRET_ID"
export RECORDER_SECRET_ID
unset RECORDER_SECRET_PAYLOAD
```

If Nebius rejects the two-role union on one bucket, stop and inspect the tenant. The documented fallback is `storage.object-editor`, but it also grants delete and restore actions and should not be applied without approval.

## 4. Vercel bucket reader identity

```bash
READER_SA_ID="$(nebius iam service-account create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-season-reader \
  --format jsonpath='{.metadata.id}')"
test -n "$READER_SA_ID"
export READER_SA_ID
READER_GROUP_ID="$(nebius iam group create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-season-readers \
  --format jsonpath='{.metadata.id}')"
test -n "$READER_GROUP_ID"
export READER_GROUP_ID
nebius iam access-permit create \
  --parent-id "$READER_GROUP_ID" \
  --resource-id "$BUCKET_ID" \
  --role storage.object-viewer
nebius iam group-membership create \
  --parent-id "$READER_GROUP_ID" \
  --member-id "$READER_SA_ID"
nebius iam v2 access-key create \
  --parent-id "$PROJECT_ID" \
  --account-service-account-id "$READER_SA_ID" \
  --expires-at 2026-12-17T00:00:00Z \
  --description 'Labelhand season Object Storage reader' \
  --secret-delivery-mode inline \
  --format json > "$READER_KEY_FILE"
READER_ACCESS_KEY_ID="$(jq -er '.status.aws_access_key_id | select(type == "string" and length > 0)' "$READER_KEY_FILE")"
test -n "$READER_ACCESS_KEY_ID"
export READER_ACCESS_KEY_ID
READER_SECRET_ACCESS_KEY="$(jq -er '.status.secret | select(type == "string" and length > 0)' "$READER_KEY_FILE")"
test -n "$READER_SECRET_ACCESS_KEY"
export READER_SECRET_ACCESS_KEY
```

## 5. Seed the compact static season

The live index extends the committed static index. Seed the compact files before the first job so issuance counts and history remain continuous. A rebuild keeps any seeded issuance of the day it rebuilds (`keep_stored_issuances`), because the seed carries no raw hourly objects.

```bash
AWS_ACCESS_KEY_ID="$WRITER_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$WRITER_SECRET_ACCESS_KEY" \
aws --region "$REGION_ID" \
  --endpoint-url "https://storage.$REGION_ID.nebius.cloud" \
  s3 cp web/public/data/season "s3://$BUCKET_NAME/season" \
  --recursive
AWS_ACCESS_KEY_ID="$WRITER_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$WRITER_SECRET_ACCESS_KEY" \
aws --region "$REGION_ID" \
  --endpoint-url "https://storage.$REGION_ID.nebius.cloud" \
  s3api head-object \
  --bucket "$BUCKET_NAME" \
  --key season/index.json > /dev/null
```

## 6. Registry and image

Build from the repository root because the Dockerfile copies shared recorder code and the tracked point cache.

```bash
REGISTRY_ID="$(nebius registry create \
  --parent-id "$PROJECT_ID" \
  --name labelhand-recorder \
  --format jsonpath='{.metadata.id}')"
test -n "$REGISTRY_ID"
export REGISTRY_ID
export REGISTRY_PATH="${REGISTRY_ID#registry-}"
RECORDER_TAG="$(git rev-parse --short=12 HEAD)"
test -n "$RECORDER_TAG"
export RECORDER_TAG
export RECORDER_IMAGE="cr.$REGION_ID.nebius.cloud/$REGISTRY_PATH/labelhand-recorder:$RECORDER_TAG"
nebius registry configure-helper
docker build \
  --file tools/recorder_job/Dockerfile \
  --tag "$RECORDER_IMAGE" \
  .
docker push "$RECORDER_IMAGE"
```

Jobs in the same Nebius project can pull this image without separate registry credentials.

## 7. GitHub Actions secrets and variables

These commands target the current repository selected by `gh`. Confirm with `gh repo view` before writing anything.

```bash
gh repo view
gh secret set NEBIUS_SA_CREDENTIALS < "$LAUNCHER_CREDENTIALS"
gh variable set NEBIUS_PROJECT_ID --body "$PROJECT_ID"
gh variable set NEBIUS_RECORDER_IMAGE --body "$RECORDER_IMAGE"
gh variable set NEBIUS_RECORDER_SECRET_SELECTOR --body "$RECORDER_SECRET_ID"
gh variable set NEBIUS_RECORDER_BUCKET --body "$BUCKET_NAME"
gh variable set NEBIUS_RECORDER_S3_ENDPOINT --body "https://storage.$REGION_ID.nebius.cloud"
gh variable set NEBIUS_JOB_PLATFORM --body 'cpu-d3'
gh variable set NEBIUS_JOB_PRESET --body '2vcpu-8gb'
gh variable set NEBIUS_JOB_SUBNET_ID --body "$SUBNET_ID"
```

Do not manually dispatch the workflow until every verification in the final section passes.

## 8. Vercel production environment

Verify the local Vercel link before changing production environment values. Do not continue if the project name is not the dedicated Labelhand project.

```bash
test "$(jq -r '.projectName' web/.vercel/project.json)" = "$EXPECTED_VERCEL_PROJECT"
printf '%s' "$BUCKET_NAME" | vercel env add SEASON_BUCKET production --cwd web
printf '%s' "https://storage.$REGION_ID.nebius.cloud" | vercel env add SEASON_S3_ENDPOINT production --cwd web
printf '%s' "$READER_ACCESS_KEY_ID" | vercel env add SEASON_READ_KEY_ID production --cwd web
printf '%s' "$READER_SECRET_ACCESS_KEY" | vercel env add SEASON_READ_SECRET production --cwd web
vercel env ls --cwd web
```

Trigger the existing production deployment path only after the four names appear. Do not let `vercel` create or relink a project interactively.

## 9. Verification before enabling the schedule

Run every check. Do not infer success from a create command.

```bash
nebius compute platform list --parent-id "$PROJECT_ID"
nebius vpc subnet get "$SUBNET_ID"
gh secret list
gh variable list
curl --fail --silent --show-error \
  "https://<labelhand-production-host>/api/season/index.json" \
  --output "$SETUP_DIR/live-season-index.json"
jq -e '.points.tift.days | length > 0' "$SETUP_DIR/live-season-index.json" > /dev/null
```

Then use `workflow_dispatch` once. Record the job ID, elapsed time, terminal `COMPLETED` state, Object Storage timestamps, workflow URL, and billed cost. Confirm the job stays under the three-minute billing target before leaving the cron enabled.

## Not verified

- No authenticated Nebius command in this document has been run.
- The inline access-key response paths used by the fail-closed `jq -er` commands have not been checked against an authenticated create response.
- `cpu-d3` and `2vcpu-8gb` are listed for the `us-central1` project; Serverless AI capacity is verified only by the first dispatched job.
- The `storage.viewer` plus `storage.uploader` role pair is documented by its action union, but has not been exercised together in this tenant.
- SecretStash injection through the launcher's `editor` role has not been exercised in this tenant.
- The active-job list schema is primary-source verified but has not been exercised against this project.
- The selected subnet's outbound path is not verified.
- The pinned CLI binary accepts the documented flags in local `--help`; an authenticated job creation with version `0.12.283` is not verified.
- GitHub Actions scheduled execution, Vercel environment wiring, S3 signature compatibility, live NWS access, duration, and billed cost are not verified.

After setup and verification, remove the temporary credential files without printing them:

```bash
rm -rf "$SETUP_DIR"
unset LAUNCHER_CREDENTIALS WRITER_KEY_FILE READER_KEY_FILE
unset WRITER_ACCESS_KEY_ID WRITER_SECRET_ACCESS_KEY RECORDER_SECRET_ID
unset READER_ACCESS_KEY_ID READER_SECRET_ACCESS_KEY
```
