/**
 * Reads the latest air-quality sample from QingSnow2App's SQLite history DB.
 *
 * We do not touch the sensors directly - QingSnow2App owns them and writes a
 * fresh row into `table_host_cache_data` every ~60s. We just tail that table,
 * read-only, via the device's own `sqlite3` binary (v3.21, no -json mode).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import config from "./config.mjs";

const execFileAsync = promisify(execFile);

const COLUMNS = [
    "temperature", // degC
    "humidity", // %RH
    "pm25", // ug/m3
    "pm10", // ug/m3
    "co2", // ppm
    "tvoc", // ppb (Qingping eTVOC)
    "noise", // dB (no Matter cluster - informational only)
    "pm25_status",
    "pm10_status",
    "co2_status",
    "tvoc_status",
    "humidity_status",
    "temperature_status",
    "timestamp", // unix seconds
];

const QUERY =
    `PRAGMA busy_timeout=3000; SELECT ${COLUMNS.join(",")} ` +
    `FROM table_host_cache_data ORDER BY _id DESC LIMIT 1;`;

/** Plausibility gates - a value outside the range is dropped (published as null). */
const RANGES = {
    temperature: [-40, 125],
    humidity: [0, 100],
    pm25: [0, 1000],
    pm10: [0, 2000],
    co2: [0, 40000],
    tvoc: [0, 60000],
    noise: [0, 150],
};

function sane(name, value) {
    if (value === null || Number.isNaN(value)) return null;
    const r = RANGES[name];
    if (r && (value < r[0] || value > r[1])) return null;
    return value;
}

/**
 * @returns {Promise<null | {
 *   temperature:number|null, humidity:number|null, pm25:number|null, pm10:number|null,
 *   co2:number|null, tvoc:number|null, noise:number|null,
 *   ageS:number, stale:boolean, statuses:number[]
 * }>}
 */
export async function readLatest() {
    let stdout;
    try {
        ({ stdout } = await execFileAsync(
            config.sqliteBin,
            [`file:${config.dbPath}?mode=ro`, QUERY],
            { timeout: 5000, maxBuffer: 64 * 1024 },
        ));
    } catch (err) {
        console.error(`[sensors] sqlite read failed: ${err.message}`);
        return null;
    }

    const line = stdout.trim().split("\n").pop() ?? "";
    const parts = line.split("|");
    if (parts.length < COLUMNS.length) {
        console.error(`[sensors] unexpected row: ${JSON.stringify(line)}`);
        return null;
    }

    const row = {};
    COLUMNS.forEach((c, i) => {
        const raw = parts[i];
        row[c] = raw === "" || raw === undefined ? null : Number(raw);
    });

    const nowS = Math.floor(Date.now() / 1000);
    const ageS = row.timestamp ? Math.max(0, nowS - row.timestamp) : Number.POSITIVE_INFINITY;
    const stale = ageS > config.staleAfterS;

    const out = {
        temperature: stale ? null : sane("temperature", row.temperature),
        humidity: stale ? null : sane("humidity", row.humidity),
        pm25: stale ? null : sane("pm25", row.pm25),
        pm10: stale ? null : sane("pm10", row.pm10),
        co2: stale ? null : sane("co2", row.co2),
        tvoc: stale ? null : sane("tvoc", row.tvoc),
        noise: stale ? null : sane("noise", row.noise),
        ageS,
        stale,
        statuses: [
            row.pm25_status,
            row.pm10_status,
            row.co2_status,
            row.tvoc_status,
            row.humidity_status,
            row.temperature_status,
        ].map(v => (v === null ? 0 : v)),
    };
    return out;
}

export default readLatest;
