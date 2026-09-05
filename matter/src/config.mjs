/**
 * Configuration for the Qingping CGS2 Matter bridge.
 *
 * Every value can be overridden with an environment variable of the same name,
 * which is handy when testing on a workstation instead of the device.
 */

import os from "node:os";

const env = process.env;

/** Derive a stable, per-device serial from the first real MAC we can find
 *  (wlan0 on the CGS2). Means QP_SERIAL doesn't need to be set by hand. */
function detectSerial() {
    try {
        const ifaces = os.networkInterfaces();
        const candidates = ["wlan0", "eth0", ...Object.keys(ifaces)];
        for (const name of candidates) {
            const mac = ifaces[name]?.find(i => !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")?.mac;
            if (mac) return mac.replace(/:/g, "").toUpperCase();
        }
    } catch {
        /* fall through */
    }
    return "CGS2-UNKNOWN";
}

export const config = {
    // Where QingSnow2App keeps its rolling sensor history (SQLite, written every
    // `save_history_interval` seconds - 60s by default).  Read-only for us.
    dbPath: env.QP_DB_PATH ?? "/data/etc/Snow2.db",
    sqliteBin: env.QP_SQLITE_BIN ?? "/usr/bin/sqlite3",

    // matter.js on-disk state (fabrics, keys, endpoint numbers). MUST live on the
    // persistent /data partition so commissioning survives a reboot.
    storagePath: env.QP_STORAGE_PATH ?? "/data/matter",

    // How often we copy the latest DB row into the Matter attributes.
    pollMs: Number(env.QP_POLL_MS ?? 30_000),

    // A reading older than this (seconds) is treated as "sensor unavailable" and
    // the measured values are published as null.
    staleAfterS: Number(env.QP_STALE_AFTER_S ?? 300),

    // Matter commissioning. Fixed so the pairing code never changes.
    // Passcode must not be one of the disallowed trivial values and is 1..99999998.
    passcode: Number(env.QP_PASSCODE ?? 20202021),
    discriminator: Number(env.QP_DISCRIMINATOR ?? 3840),
    port: Number(env.QP_PORT ?? 5540),

    // BasicInformation cluster. Test vendor id 0xFFF1 => matter.js ships matching
    // test attestation certs, so commissioning works with no PKI setup. Apple Home
    // will show an "uncertified accessory" prompt - expected for a DIY device.
    vendorId: Number(env.QP_VENDOR_ID ?? 0xfff1),
    productId: Number(env.QP_PRODUCT_ID ?? 0x8000),
    vendorName: env.QP_VENDOR_NAME ?? "Qingping (DIY)",
    productName: env.QP_PRODUCT_NAME ?? "CGS2 Matter Bridge",
    // Stable per-device serial / unique id. Defaults to this device's own wlan0
    // MAC (no colons); override with QP_SERIAL if you'd rather set it by hand.
    serialNumber: env.QP_SERIAL ?? detectSerial(),
};

export default config;
