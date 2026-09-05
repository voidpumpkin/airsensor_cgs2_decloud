#!/usr/bin/env bash
#
# Push the bundled controller (dist/qp-ctl.mjs) to the CGS2 and run it there.
#
# We run the controller ON the device because matter.js's built-in mDNS resolver
# does not reliably receive responses on macOS (mDNSResponder owns :5353), so
# operational (post-PASE) discovery stalls. On the device's Linux stack it just
# works, and localhost/LAN commissioning needs no mDNS at all.
#
#   ./deploy-ctl.sh                       # just copy the bundle over
#   ./deploy-ctl.sh commission            # copy + run: pair on-network
#   ./deploy-ctl.sh read                  # copy + run: dump attributes
#   ./deploy-ctl.sh open-window [secs]    # copy + run: print Apple Home code
#   ./deploy-ctl.sh decommission          # copy + run: drop the qp-ctl fabric
#
set -euo pipefail

CGS2_HOST="${CGS2_HOST:-root@192.168.1.189}"
CGS2_SSH_KEY="${CGS2_SSH_KEY:-$HOME/.ssh/qingping_cgs2_rsa}"
NODE="${NODE:-/data/node/bin/node}"
REMOTE_DIR="${REMOTE_DIR:-/data/matter-tools}"

SSH_OPTS=(-i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
          -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa
          -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=18)
sh_()  { ssh "${SSH_OPTS[@]}" "$CGS2_HOST" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

cd "$(dirname "$0")"
[[ -f dist/qp-ctl.mjs ]] || { echo "dist/qp-ctl.mjs missing - run 'npm run build'"; exit 1; }

echo ">> copying qp-ctl bundle ($(($(wc -c < dist/qp-ctl.mjs) / 1024)) KiB)"
sh_ "mkdir -p $REMOTE_DIR"
scp_ dist/qp-ctl.mjs "$CGS2_HOST:$REMOTE_DIR/qp-ctl.mjs"

CMD="${1:-}"
[[ -z "$CMD" ]] && { echo ">> copied. Run a subcommand: commission | read | open-window | decommission"; exit 0; }
shift || true

# On-device: commission against the device's own LAN address; operational
# discovery then resolves locally.
DEV_ARGS=("$CMD")
case "$CMD" in
    commission) DEV_ARGS+=(--ip=127.0.0.1) ;;
    open-window) [[ $# -ge 1 ]] && DEV_ARGS+=("--window-seconds=$1") ;;
esac

echo ">> running: qp-ctl ${DEV_ARGS[*]}"
sh_ "cd $REMOTE_DIR && QP_LOG_LEVEL=\${QP_LOG_LEVEL:-info} $NODE qp-ctl.mjs ${DEV_ARGS[*]}"
