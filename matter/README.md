# CGS2 → Matter over WiFi

Turns the de-clouded Qingping CGS2 into a **Matter Air Quality Sensor** that any
Matter controller can commission over Wi‑Fi (no Bluetooth needed on the device).

```
QingSnow2App (unchanged) ──► /data/etc/Snow2.db ──► local MQTT (unchanged)
                                   │  read-only, every ~30 s
                                   ▼
/data/node/bin/node  /data/matter-app/src/qp-air-quality.mjs   (matter.js ServerNode)
   ├─ built-in mDNS (no avahi)         ── _matterc._udp / _matter._tcp on the LAN
   ├─ storage ──► /data/matter/        (fabrics + keys, survives reboot)
   └─ endpoint 1: Air Quality Sensor
        AirQuality · Temperature · RelativeHumidity
        CO₂ / PM2.5 / PM10 / TVOC  ConcentrationMeasurement
```

It runs entirely on the device on **Node.js 20** + [matter.js](https://github.com/matter-js/matter.js).
Nothing is compiled; the app is bundled to one `.mjs` file with esbuild.

## What it exposes

Three **separate endpoints** — Apple Home only shows a Temperature / Humidity
tile from an endpoint whose *device type* is Temperature/Humidity Sensor, so
those can't live on the Air Quality endpoint:

| Endpoint | Device type | Attribute | Source column in `table_host_cache_data` | Unit sent |
|---|---|---|---|---|
| **ep1** | Air Quality Sensor | `AirQuality.airQuality` | worst of the `*_status` columns → `AirQualityEnum` | — |
| | | `CarbonDioxideConcentrationMeasurement.measuredValue` | `co2` | ppm |
| | | `Pm25ConcentrationMeasurement.measuredValue` | `pm25` | µg/m³ |
| | | `Pm10ConcentrationMeasurement.measuredValue` | `pm10` | µg/m³ |
| | | `TotalVolatileOrganicCompounds…measuredValue` | `tvoc` | ppb (see `QP_TVOC_UNIT`) |
| **ep2** | Temperature Sensor | `TemperatureMeasurement.measuredValue` | `temperature` | 0.01 °C |
| **ep3** | Humidity Sensor | `RelativeHumidityMeasurement.measuredValue` | `humidity` | 0.01 %RH |

`noise` has no standard Matter cluster and is not exposed. A reading older than
`QP_STALE_AFTER_S` (default 300 s) is published as `null`.

## Layout

| Path (repo) | Path (device) | What |
|---|---|---|
| `src/qp-air-quality.mjs` | — | the app (source) |
| `src/sensors.mjs` | — | reads newest `Snow2.db` row via the device's `sqlite3` |
| `src/config.mjs` | — | passcode / discriminator / paths / interval (all env-overridable) |
| `dist/qp-air-quality.mjs` | `/data/matter-app/src/qp-air-quality.mjs` | esbuild bundle (deployed) |
| `S60matter` | `/etc/init.d/S60matter` + `/data/matter-app/S60matter` | supervised init script |
| — | `/data/node/` | Node 20 arm64 runtime |
| — | `/data/matter/` | matter.js state (fabrics, keys) + `qp-matter.log` |

> **New device, starting fresh?** Follow [`../DEPLOY.md`](../DEPLOY.md) instead
> - it walks through all of this (including the SSH key) in order. This
> section is the component-level reference for the bridge specifically.

## First-time setup

### 1. Node.js 20 on the device (once)

The device has a real `xz` (`/usr/bin/xz`), so no repacking needed:

```sh
# on a workstation
curl -LO https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-arm64.tar.xz
scp -i ~/.ssh/qingping_cgs2_rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa \
  node-v20.20.2-linux-arm64.tar.xz root@192.168.1.189:/data/node.tar.xz

# on the device
cd /data && xz -dc node.tar.xz | tar -xf - \
  && mv node-v20.20.2-linux-arm64 node && rm node.tar.xz
/data/node/bin/node -v          # -> v20.20.2
```

Node 20's arm64 build needs glibc ≥ 2.28 / kernel ≥ 4.18; the CGS2 has glibc 2.29
/ kernel 4.19, so the stock binary runs unmodified.

### 2. Stop the boot-time fsck that mangles permissions (once)

The `userdata` (ext2) partition's boot `fsck -y` has been observed to strip the
exec bit off `node` and the search bit off our state dirs after an unclean power
cycle. Disable it:

```sh
ssh root@192.168.1.189 'touch /.skip_fsck; sync'
```

`S60matter` also re-asserts sane modes on every start as a backstop.

### 3. Build & deploy the bridge

```sh
cd matter
npm install
npm run build                                   # -> dist/qp-air-quality.mjs
CGS2_SSH_KEY=~/.ssh/id_rsa ./deploy.sh           # copies bundle + S60matter, restarts
```

`deploy.sh` env: `CGS2_HOST` (default `root@192.168.1.189`), `CGS2_SSH_KEY`,
`NODE_PREFIX` (`/data/node`), `APP_DIR` (`/data/matter-app`).

> The device's dropbear is old — it only does SHA‑1 `ssh-rsa`. Use an **RSA** key
> and `ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa`
> (deploy.sh already passes these). ed25519 keys are rejected.

### 4. Commission — see [`../tools/README.md`](../tools/README.md)

## Operating it

```sh
ssh root@192.168.1.189 /etc/init.d/S60matter {start|stop|restart|status}
ssh root@192.168.1.189 'tail -f /data/matter/qp-matter.log'
```

`S60matter` runs the app under a tiny restart-supervisor (15 s back-off on a
fast crash), waits up to 60 s for `wlan0` to get an IPv4 address first, and
rotates the log past ~5 MiB. Memory use is ~90 MB RSS (device has ~180 MB free).

### Re-deploy after a code change

```sh
npm run build && ./deploy.sh
```

Matter state in `/data/matter/` is untouched, so the device stays commissioned.

## Config knobs (`src/config.mjs`, all env-overridable, set in `S60matter`)

| env | default | meaning |
|---|---|---|
| `QP_DB_PATH` | `/data/etc/Snow2.db` | QingSnow2App history DB (read-only) |
| `QP_SQLITE_BIN` | `/usr/bin/sqlite3` | on-device sqlite CLI |
| `QP_STORAGE_PATH` | `/data/matter` | matter.js state dir — **must be on `/data`** |
| `QP_POLL_MS` | `30000` | sensor → Matter refresh interval |
| `QP_STALE_AFTER_S` | `300` | older reading ⇒ publish `null` |
| `QP_PASSCODE` | `20202021` | Matter setup passcode (fixed ⇒ stable pairing code) |
| `QP_DISCRIMINATOR` | `3840` | Matter discriminator |
| `QP_PORT` | `5540` | Matter operational UDP port |
| `QP_VENDOR_ID` / `QP_PRODUCT_ID` | `0xFFF1` / `0x8000` | test VID/PID (Apple shows an "uncertified" prompt — expected) |
| `QP_TVOC_UNIT` | `ppb` | set to `ugm3` if a controller won't render VOC in ppb; converts with `QP_TVOC_UGM3_PER_PPB` (default `4.57`) |
| `QP_SERIAL` | *(auto-detected: this device's own wlan0 MAC)* | pin a specific serial number instead |

## Notes / caveats

- **Test attestation.** The bundle uses matter.js's built-in test PAA/PAI/DAC for
  VID `0xFFF1`. Commissioning works with zero PKI setup; Apple/Google warn about
  an uncertified accessory. Fine for a DIY device; not for redistribution.
- **`/etc/init.d/S60matter` lives on the rootfs** and could be wiped by a firmware
  OTA. Keep `matter/S60matter` in the repo and re-run `deploy.sh` if that happens.
  Everything else (Node, app, state) is on `/data` and persists.
- **Wi‑Fi is flaky.** The SeekWave SDIO combo chip drops the link for tens of
  seconds at a time. The supervisor + matter.js's own reconnection ride it out;
  controllers just re-subscribe.
- The app reads `Snow2.db` **read-only** via `file:…?mode=ro`; QingSnow2App and the
  existing MQTT flow are completely untouched.
