#!/usr/bin/env bash
# Puts an already pulled and uploaded release live on the cPanel host, in the one
# order that never leaves the site half-deployed:
#   1. database migrations  (old code keeps running on the new, additive schema)
#   2. Telegram webhook     (new code refuses deliveries that lack the secret header)
#   3. the .next folder     (backed up first, then replaced from kvaterka-build.zip)
#   4. Passenger restart, then a health check.
#
# Run it from the app root inside the cPanel Terminal, in the app's virtualenv,
# after `git pull` and after kvaterka-build.zip has been uploaded:
#     bash deploy/apply-release.sh
# DRY_RUN=1 prints every step without running one. Secrets are read from the Node
# selector's own config and are never printed or written anywhere.
set -Eeuo pipefail
trap 'printf "\nSTOP: a step failed (line %s). Nothing after it was run.\n" "$LINENO" >&2' ERR

cd "$(dirname "$0")/.."
APP_DIR="$(basename "$PWD")"
CONFIG="$HOME/.cl.selector/node-selector.json"
ZIP="kvaterka-build.zip"
STAMP="$(date +%Y%m%d-%H%M)"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
run() { if [ -n "${DRY_RUN:-}" ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

# One value of the app's environment as cPanel stores it; empty when unset.
env_value() {
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const apps = Object.values(c).filter((v) => v && v.env_vars);
    const app = c[process.argv[2]] || (apps.length === 1 ? apps[0] : null);
    if (!app) {
      process.stderr.write("cannot tell which app in " + process.argv[1] + " is this one\n");
      process.exit(3);
    }
    const v = (app.env_vars || {})[process.argv[3]];
    process.stdout.write(v == null ? "" : String(v));
  ' "$CONFIG" "$APP_DIR" "$1"
}

command -v node >/dev/null || die "node is not on PATH: run  source ~/nodevenv/$APP_DIR/22/bin/activate  first"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "Node $(node -v) is too old for the migration scripts (needs 22): activate the Node 22 virtualenv"
[ -f "$CONFIG" ] || die "$CONFIG not found: this script runs on the host, not on your own computer"
[ -f "$ZIP" ] || die "$ZIP is not in $PWD: upload it first (HOW_TO_UPDATE_THE_SITE.md, step 2.6)"
command -v unzip >/dev/null || die "unzip is missing: extract $ZIP with File Manager and do steps 1, 2 and 4 by hand"
# The listing is captured first and grep reads all of it: under pipefail a grep -q
# that closes the pipe early can make unzip die of SIGPIPE and fail a check that
# passed. Backslashes are tolerated so a zip from an older make-deploy-zip.ps1
# (see the comment there) still passes.
ENTRIES="$(unzip -Z1 "$ZIP" | tr '\\' '/')"
printf '%s\n' "$ENTRIES" | grep -x '\.next/BUILD_ID' >/dev/null \
  || die "$ZIP has no .next/BUILD_ID: it is not a build made by make-deploy-zip.ps1"
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "tracked files are modified on the host, so git pull would have refused too: look at git status"

say "1/4 database migrations"
DB_URL="$(env_value DATABASE_URL)"
[ -n "$DB_URL" ] || die "DATABASE_URL is not set in the app's environment"
DB_SSL="$(env_value DATABASE_SSL)"
if [ -n "$DB_SSL" ]; then
  DATABASE_URL="$DB_URL" DATABASE_SSL="$DB_SSL" run npm run db:migrate
else
  DATABASE_URL="$DB_URL" run npm run db:migrate
fi

say "2/4 Telegram webhook"
TG_TOKEN="$(env_value TELEGRAM_BOT_TOKEN)"
BASE_URL="$(env_value PUBLIC_BASE_URL)"
BASE_URL="${BASE_URL:-https://kvaterka.by}"
if [ -z "$TG_TOKEN" ]; then
  echo "TELEGRAM_BOT_TOKEN is not set: skipped. The bot and phone verification cannot work without it."
else
  TELEGRAM_BOT_TOKEN="$TG_TOKEN" PUBLIC_BASE_URL="$BASE_URL" run npm run telegram:webhook
fi

say "3/4 the new build"
if [ -d .next ]; then run cp -r .next ".next.backup-$STAMP"; fi
UNZIP_STATUS=0
run unzip -oq "$ZIP" || UNZIP_STATUS=$?
# unzip exits 1 for warnings only (backslash separators in an old zip, for example):
# the files are extracted. Anything above that is a real failure.
[ "$UNZIP_STATUS" -le 1 ] || die "unzip failed (exit $UNZIP_STATUS). Restore: rm -rf .next && mv .next.backup-$STAMP .next"
run rm -f "$ZIP"
if [ -z "${DRY_RUN:-}" ] && [ ! -f .next/BUILD_ID ]; then
  die ".next/BUILD_ID is missing after extracting. Restore: rm -rf .next && mv .next.backup-$STAMP .next"
fi

say "4/4 restart and check"
run mkdir -p tmp
run touch tmp/restart.txt
if [ -z "${DRY_RUN:-}" ]; then
  sleep 8
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE_URL/" || true)"
  echo "site answers HTTP ${code:-000}"
  curl -s --max-time 30 "$BASE_URL/api/health" | head -c 600 || true
  echo
  [ "$code" = "200" ] \
    || die "the site did not answer 200. Roll back: rm -rf .next && mv .next.backup-$STAMP .next && touch tmp/restart.txt"
fi

say "done"
