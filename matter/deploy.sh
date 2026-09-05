#!/usr/bin/env bash
#
# Deploy the Matter bridge to the CGS2.
#
#   npm run build && ./deploy.sh      # or just: npm run deploy
#
# Ships two files: the esbuild single-file bundle (dist/qp-air-quality.mjs) and
# the init script. No node_modules on the device - everything is in the bundle.
# Node 20 must already be unpacked at $NODE_PREFIX (see README, Phase 1).
#
# Config via env:
#   CGS2_HOST      default root@192.168.1.189
#   CGS2_SSH_KEY   default ~/.ssh/qingping_cgs2_rsa
#   NODE_PREFIX    default /data/node
#   APP_DIR        default /data/matter-app
#
# Flags:
#   --no-restart   push files but don't (re)start the service
#
set -euo pipefail

CGS2_HOST="${CGS2_HOST:-root@192.168.1.189}"
CGS2_SSH_KEY="${CGS2_SSH_KEY:-$HOME/.ssh/qingping_cgs2_rsa}"
NODE_PREFIX="${NODE_PREFIX:-/data/node}"
APP_DIR="${APP_DIR:-/data/matter-app}"

SSH_OPTS=(-i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
          -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa
          -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=12)
sh_() { ssh "${SSH_OPTS[@]}" "$CGS2_HOST" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

RESTART=1
for a in "$@"; do
    case "$a" in
        --no-restart) RESTART=0 ;;
        *) echo "unknown arg: $a" >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")"
[[ -f dist/qp-air-quality.mjs ]] || { echo "dist/qp-air-quality.mjs missing - run 'npm run build'"; exit 1; }

echo ">> uploading bundle ($(($(wc -c < dist/qp-air-quality.mjs) / 1024)) KiB) + init script"
sh_ "mkdir -p $APP_DIR $APP_DIR/src /data/matter && rm -f $APP_DIR/src/*.mjs $APP_DIR/package.json"
scp_ dist/qp-air-quality.mjs "$CGS2_HOST:$APP_DIR/src/qp-air-quality.mjs"
scp_ S60matter "$CGS2_HOST:$APP_DIR/S60matter"

echo ">> installing init script"
sh_ "set -e
    cp $APP_DIR/S60matter /etc/init.d/S60matter
    chmod +x /etc/init.d/S60matter
    sed -i 's#^NODE_PREFIX=.*#NODE_PREFIX=$NODE_PREFIX#; s#^APP_DIR=.*#APP_DIR=$APP_DIR#' /etc/init.d/S60matter
    chown -R root:root $APP_DIR
    ls -la $APP_DIR $APP_DIR/src"

if [[ $RESTART -eq 1 ]]; then
    echo ">> restarting service"
    sh_ "/etc/init.d/S60matter restart"
    sleep 4
    sh_ "/etc/init.d/S60matter status; echo '--- log tail ---'; tail -n 30 /data/matter/qp-matter.log 2>/dev/null || true"
fi
echo ">> done"
