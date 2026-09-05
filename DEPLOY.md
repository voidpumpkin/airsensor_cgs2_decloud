# Deploying Matter over WiFi — end to end

A copy-paste guide to turn a de-clouded CGS2 into a Matter Air Quality Sensor,
starting from a clean checkout of this repo and a device that only has
password SSH so far. Total time: ~15 minutes plus however long the CGS2's
Wi‑Fi feels like cooperating (see [Troubleshooting](#troubleshooting) — it's
a bit flaky).

**Prerequisite:** the device is already de-clouded per the main
[`README.md`](README.md) — root shell, connected to your Wi‑Fi, internet
blocked, reachable as `ssh root@<its-ip>` with password `rockchip`. This guide
picks up from there.

## 0. Set your environment variables

These two are the only things you need to customize. Everything else in this
guide (and in `deploy.sh` / `deploy-ctl.sh`) defaults sensibly from them.

```sh
export CGS2_HOST=root@192.168.1.189          # the device's IP on your LAN
export CGS2_SSH_KEY=~/.ssh/qingping_cgs2_rsa # key we're about to create
```

Keep this shell around (or re-`export` in each new one) for the rest of the guide.

## 1. Clone and install dependencies

```sh
git clone <this-repo-url> cgs2_decloud && cd cgs2_decloud
(cd matter && npm install)
(cd tools  && npm install)
```

Both `matter/` and `tools/` are independent Node projects; their dependency
([matter.js](https://github.com/matter-js/matter.js)) is pure JS, so this just
needs a normal Node ≥ 18 on your workstation (not the device).

## 2. Give yourself passwordless SSH

The CGS2's dropbear is old enough that it only speaks SHA‑1 `ssh-rsa` — **you
must generate an RSA key**; ed25519 keys are silently rejected.

```sh
ssh-keygen -t rsa -b 3072 -N '' -C 'qingping-cgs2' -f "$CGS2_SSH_KEY"

# copy it to the device (password: rockchip)
PUB=$(cat "$CGS2_SSH_KEY.pub")
ssh "$CGS2_HOST" "mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
  echo '$PUB' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"

# verify - should NOT prompt for a password
ssh -i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa \
    "$CGS2_HOST" 'echo key auth OK; date; uptime'
```

`deploy.sh` and `deploy-ctl.sh` already pass the `PubkeyAcceptedAlgorithms`/
`HostkeyAlgorithms` options for you; only add them yourself when running `ssh`
or `scp` by hand against the device.

## 3. Install Node.js 20 on the device

The CGS2 (Buildroot, glibc 2.29, kernel 4.19, aarch64) runs the **stock Node 20
arm64 build** unmodified — no cross-compiling. Do this once:

```sh
NODE_VERSION=20.20.2
curl -LO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"

scp -i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa \
    "node-v${NODE_VERSION}-linux-arm64.tar.xz" "$CGS2_HOST:/data/node.tar.xz"

ssh -i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa "$CGS2_HOST" '
  set -e
  cd /data
  rm -rf node node-v*-linux-arm64
  xz -dc node.tar.xz | tar -xf -
  mv node-v*-linux-arm64 node
  rm node.tar.xz
  /data/node/bin/node -v
'
```

Should print `v20.20.2`. (Node 20 needs glibc ≥ 2.28 / kernel ≥ 4.18 — the
CGS2 clears both, which is the whole reason this project doesn't need a C++
Matter SDK cross-compile.)

## 4. Stop the boot-time fsck that mangles permissions

The `userdata` (ext2) partition's boot `fsck -y` has been observed to strip
the exec bit off `node` and the search bit off our state dirs after an
unclean power cycle. Disable it once:

```sh
ssh -i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa \
    "$CGS2_HOST" 'touch /.skip_fsck; sync'
```

`S60matter` also re-asserts sane modes on every start as a backstop, so this
step is a belt-and-suspenders precaution, not a hard dependency.

## 5. Build & deploy the Matter bridge

```sh
cd matter
npm run build                 # -> dist/qp-air-quality.mjs (esbuild bundle)
./deploy.sh                   # copies the bundle + S60matter, installs the
                               # init script, restarts the service
cd ..
```

Check it came up:

```sh
ssh -i "$CGS2_SSH_KEY" -o IdentitiesOnly=yes \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa \
    "$CGS2_HOST" '/etc/init.d/S60matter status; tail -n 15 /data/matter/qp-matter.log'
```

You should see `qp-matter: running` and a `manual pairing code:` line (device
is commissionable) or `[qp-matter] T=... RH=... CO2=...` lines (already
commissioned and reporting).

## 6. Commission it on-network (no BLE)

Apple/Google always need BLE for the *first* commissioning, which this device
can't do. So we commission with the small `qp-ctl` controller instead — it
runs **on the device itself** (macOS's mDNS doesn't cooperate with matter.js,
so running the controller there stalls; Linux just works):

```sh
cd tools
npm run build                 # -> dist/qp-ctl.mjs
./deploy-ctl.sh commission     # pairs on-network, then reads back every value
                                # to confirm it matches the live sensors
```

Expect output like:

```
BasicInformation:  vendor "Qingping (DIY)"  product "CGS2 Matter Bridge"
AirQualitySensor (ep1):  airQuality 1 (Good)  co2 1080 ppm  pm2.5 6  pm10 6  tvoc 52
TemperatureSensor (ep2): 22.6 C
HumiditySensor (ep3):    62.5 %
```

If you're using **Home Assistant** instead, skip this step: HA's Matter
server commissions on-network directly. Point it at the device and use the
default passcode/discriminator below (or the ones you set via
`QP_PASSCODE`/`QP_DISCRIMINATOR`).

## 7. Add it to Apple Home

```sh
./deploy-ctl.sh open-window 900
```

Copy the **MANUAL PAIRING CODE** it prints (or use the QR URL). Then, on your
iPhone: **Home app → Add Accessory → More options… → Enter Code**. Apple
finds the CGS2 over Wi‑Fi (no BLE needed - it's joining as a second admin on
a device that's already on the network), warns **"uncertified accessory"**
(expected - it's a DIY device using matter.js's test certificates), accept,
and three tiles appear: Air Quality, Temperature, Humidity.

The code is regenerated every call and only valid for the window (≤ 900 s);
re-run `open-window` if you don't finish pairing in time.

## Done

- Bridge lives on `/data` on the device and auto-starts on boot
  (`/etc/init.d/S60matter start|stop|restart|status`).
- To change a setting or push new code: edit, `npm run build`, `./deploy.sh`
  again (Matter state under `/data/matter/` is untouched, so it stays paired).
- Full details: [`matter/README.md`](matter/README.md) (the bridge) and
  [`tools/README.md`](tools/README.md) (`qp-ctl`).

---

## Environment variable reference

Exported in your shell before running `deploy.sh` / `deploy-ctl.sh`:

| Variable | Default | Set it when… |
|---|---|---|
| `CGS2_HOST` | `root@192.168.1.189` | your device isn't at that IP |
| `CGS2_SSH_KEY` | `~/.ssh/qingping_cgs2_rsa` | you used a different key path/name in step 2 |
| `NODE_PREFIX` | `/data/node` | you installed Node somewhere else on the device |
| `APP_DIR` (`deploy.sh`) | `/data/matter-app` | you want the bridge elsewhere on `/data` |
| `REMOTE_DIR` (`deploy-ctl.sh`) | `/data/matter-tools` | ditto, for `qp-ctl` |

Baked into `S60matter` on the device, read by the bridge itself
(`matter/src/config.mjs`) - override by editing the `export QP_...` lines in
`/etc/init.d/S60matter`, or by exporting them before a local test run:

| Variable | Default | What it changes |
|---|---|---|
| `QP_DB_PATH` | `/data/etc/Snow2.db` | QingSnow2App's history DB (read-only) |
| `QP_SQLITE_BIN` | `/usr/bin/sqlite3` | on-device sqlite CLI |
| `QP_STORAGE_PATH` | `/data/matter` | matter.js state dir - **must stay on `/data`** |
| `QP_POLL_MS` | `30000` | sensor → Matter refresh interval, ms |
| `QP_STALE_AFTER_S` | `300` | reading older than this ⇒ published as `null` |
| `QP_PASSCODE` | `20202021` | Matter setup passcode (must match what `qp-ctl` / your controller uses) |
| `QP_DISCRIMINATOR` | `3840` | Matter discriminator (same caveat) |
| `QP_PORT` | `5540` | Matter operational UDP port |
| `QP_VENDOR_ID` / `QP_PRODUCT_ID` | `0xFFF1` / `0x8000` | test VID/PID - change only if you have real ones |
| `QP_VENDOR_NAME` / `QP_PRODUCT_NAME` | `Qingping (DIY)` / `CGS2 Matter Bridge` | cosmetic, shown in the controller |
| `QP_SERIAL` | *(auto: the device's own wlan0 MAC)* | pin a specific serial instead of auto-detecting |
| `QP_TVOC_UNIT` | `ppb` | set to `ugm3` if a controller won't render VOC in ppb (uses `QP_TVOC_UGM3_PER_PPB`, default `4.57`) |

`qp-ctl` (`tools/qp-ctl.mjs`) flags/env - only needed if you change the
bridge's passcode/discriminator away from the defaults above:

| Variable / flag | Default | What it changes |
|---|---|---|
| `--ip=` / `QP_IP` | — | skip mDNS, connect straight to this address (used automatically by `deploy-ctl.sh commission`) |
| `--window-seconds=` | `900` | commissioning-window duration (clamped 180-900 by the Matter spec) |
| `QP_PASSCODE` / `QP_DISCRIMINATOR` | `20202021` / `3840` | must match whatever the bridge is using |
| `QP_NODE_ID` | first commissioned node | which node `read`/`open-window`/`decommission` act on |

## Troubleshooting

- **`ssh`/`scp` hang or "Operation timed out during banner exchange"** — the
  CGS2's Wi‑Fi chip (a SeekWave SDIO combo) drops the link for tens of
  seconds to a few minutes at a time. This is a device quirk, not your setup.
  Just retry; `deploy.sh`/`deploy-ctl.sh` use a long `ServerAliveInterval` to
  ride out brief drops, but a bad stretch needs a manual retry.
- **"Permission denied (publickey,password)" after step 2** — you generated
  an ed25519 key, or forgot `-o PubkeyAcceptedAlgorithms=+ssh-rsa -o
  HostkeyAlgorithms=+ssh-rsa`. This dropbear only does SHA‑1 RSA.
- **Bridge keeps restarting / `node exited rc=1` in the log** — check
  `/data/matter/qp-matter.log` for the actual error. A `state inconsistency
  possible: Error when writing values into filesystem storage` line means the
  perms-mangling from step 4 happened again; `chmod -R u+rwX,go+rX /data/matter
  /data/matter-app /data/node` by hand and make sure `/.skip_fsck` exists.
- **Apple Home shows "Air Quality" but not Temperature/Humidity** — you
  paired before the bridge had separate endpoints for them (or re-flashed an
  older `qp-air-quality.mjs`). Remove the accessory from Home and repeat step 7
  - Apple won't attach new services to an already-paired accessory.
- **Changed `QP_PASSCODE`/`QP_DISCRIMINATOR`/the endpoint structure** — wipe
  state on both sides and redo steps 6-7:
  ```sh
  ssh ... "$CGS2_HOST" '/etc/init.d/S60matter stop; \
    rm -rf /data/matter/qp-cgs2 /data/matter-tools/.matter-ctl; \
    /etc/init.d/S60matter start'
  ```
