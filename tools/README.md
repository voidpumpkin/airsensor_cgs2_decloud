# qp-ctl — bring-up controller for the CGS2 Matter node

> **New device, starting fresh?** Follow [`../DEPLOY.md`](../DEPLOY.md) instead
> - it walks through everything (SSH key, Node, the bridge, this tool, Apple
> Home) in order. This page is the component-level reference for `qp-ctl`.

A tiny [matter.js](https://github.com/matter-js/matter.js) **controller** used to:

1. do the **first** on-network commissioning of the CGS2 (no BLE),
2. **verify** the sensor attributes come through, and
3. **open a commissioning window** so Apple Home / Google / another controller can
   join as a second admin. That join happens over IP, so the device never needs
   a Bluetooth stack.

If you are using HomeAssistant, the setup is simpler and this isn't required.

## Use

```sh
cd tools
npm install
npm run build                                    # -> dist/qp-ctl.mjs
export CGS2_SSH_KEY=~/.ssh/id_rsa                 # RSA key (see matter/README.md)

./deploy-ctl.sh commission        # pair on-network; then prints a verification read
./deploy-ctl.sh read              # re-read the air-quality attributes any time
./deploy-ctl.sh open-window 900   # -> MANUAL PAIRING CODE for Apple Home (≤ 900 s)
./deploy-ctl.sh decommission      # drop this controller's fabric
```

`deploy-ctl.sh` with no subcommand just copies the bundle. You can then run it on the device directly.

### Add to Apple Home

1. `./deploy-ctl.sh open-window 900` and copy the **MANUAL PAIRING CODE** it prints.
   Leave it running (or just re-run it — the window is server-side and lasts 900 s).
2. Home app → **Add Accessory** → **More options…** → **Enter Code** → type the code.
3. Apple finds the CGS2 over Wi‑Fi (no BLE). It will warn about  **"uncertified accessory"**. Accept it and sensors appear as a tile.

The code is **regenerated every call**; run `open-window` right before you pair. A URL to render a QR code is displayed so you can use that instaed of typing in the code. 


## State

Controller fabric/keys live in `tools/.matter-ctl/` (local run) or
`/data/matter-tools/.matter-ctl/` (on device). Keep it to be able to re-open the
window later; delete it to start clean (then `commission` again).

## Options

| flag / env | default | meaning |
|---|---|---|
| `--ip=<addr>` / `QP_IP` | — | skip mDNS for PASE, connect straight to this address |
| `--port=` / `QP_PORT` | `5540` | device Matter port |
| `--window-seconds=` | `900` | commissioning-window duration (clamped to 180–900) |
| `QP_PASSCODE` / `QP_DISCRIMINATOR` | `20202021` / `3840` | must match the bridge |
| `QP_NODE_ID` | first | which commissioned node to act on |
| `QP_LOG_LEVEL` | `info` | matter.js log level |

