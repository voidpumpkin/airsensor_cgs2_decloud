#!/usr/bin/env node
/**
 * Qingping CGS2  ->  Matter-over-WiFi Air Quality Sensor
 *
 * Runs on the (de-clouded) monitor itself. QingSnow2App keeps talking to the
 * sensors and the local MQTT server exactly as before; this process only reads
 * the latest row of its SQLite history DB and mirrors it into a Matter node
 * that any controller can commission on-network (no BLE).
 *
 * The node exposes THREE endpoints, because Apple Home only surfaces a
 * Temperature / Humidity tile from an endpoint whose *device type* is
 * Temperature/Humidity Sensor - it ignores those clusters when they are
 * co-located on the Air Quality Sensor endpoint:
 *
 *   ep1  Air Quality Sensor   AirQuality + CO2/PM2.5/PM10/TVOC concentration
 *   ep2  Temperature Sensor   TemperatureMeasurement
 *   ep3  Humidity Sensor      RelativeHumidityMeasurement
 *
 * (Noise has no standard Matter cluster and is not exposed.)
 *
 * See ../README.md for build / deploy / commissioning steps.
 */

import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { AirQualityServer } from "@matter/main/behaviors/air-quality";
import { CarbonDioxideConcentrationMeasurementServer } from "@matter/main/behaviors/carbon-dioxide-concentration-measurement";
import { Pm10ConcentrationMeasurementServer } from "@matter/main/behaviors/pm10-concentration-measurement";
import { Pm25ConcentrationMeasurementServer } from "@matter/main/behaviors/pm25-concentration-measurement";
import { TotalVolatileOrganicCompoundsConcentrationMeasurementServer } from "@matter/main/behaviors/total-volatile-organic-compounds-concentration-measurement";
import { AirQuality } from "@matter/main/clusters/air-quality";
import { ConcentrationMeasurement } from "@matter/main/clusters/concentration-measurement";
import { AirQualitySensorDevice } from "@matter/main/devices/air-quality-sensor";
import { HumiditySensorDevice } from "@matter/main/devices/humidity-sensor";
import { TemperatureSensorDevice } from "@matter/main/devices/temperature-sensor";

import config from "./config.mjs";
import readLatest from "./sensors.mjs";

const { MeasurementUnit, MeasurementMedium, Feature } = ConcentrationMeasurement;
const NUMERIC = Feature.NumericMeasurement;
const AIR = MeasurementMedium.Air;

/* -------------------------------------------------------------------------- */
/* value helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Matter Temperature/Humidity measured values are hundredths, int16. */
const centi = v => (v === null || v === undefined ? null : Math.round(v * 100));
/** Concentration measured values are single-precision floats; 1 decimal is plenty. */
const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/** TVOC: Qingping reports ppb. Some ecosystems only render VOC in ug/m3, so
 *  allow an opt-in relabel (QP_TVOC_UNIT=ugm3) with a rough ppb->ug/m3 factor. */
const TVOC_AS_UGM3 = (process.env.QP_TVOC_UNIT ?? "ppb").toLowerCase() === "ugm3";
const TVOC_UGM3_PER_PPB = Number(process.env.QP_TVOC_UGM3_PER_PPB ?? 4.57);
const tvocUnit = TVOC_AS_UGM3 ? MeasurementUnit.Ugm3 : MeasurementUnit.Ppb;
const tvocValue = ppb =>
    ppb === null || ppb === undefined ? null : round1(TVOC_AS_UGM3 ? ppb * TVOC_UGM3_PER_PPB : ppb);

/**
 * Fold Qingping's per-sensor status (0 best .. 4 worst) into the Matter
 * AirQualityEnum. Worst sub-status wins; no fresh data => Unknown.
 */
function airQualityEnum(reading) {
    if (!reading || reading.stale) return AirQuality.AirQualityEnum.Unknown;
    const worst = Math.max(0, ...reading.statuses.filter(n => Number.isFinite(n)));
    return [
        AirQuality.AirQualityEnum.Good, // 0
        AirQuality.AirQualityEnum.Fair, // 1
        AirQuality.AirQualityEnum.Moderate, // 2
        AirQuality.AirQualityEnum.Poor, // 3
        AirQuality.AirQualityEnum.VeryPoor, // 4
    ][worst] ?? AirQuality.AirQualityEnum.ExtremelyPoor;
}

/* -------------------------------------------------------------------------- */
/* node setup                                                                */
/* -------------------------------------------------------------------------- */

// Pin matter.js on-disk state to the persistent partition BEFORE anything in
// the SDK touches storage.
Environment.default.vars.set("storage.path", config.storagePath);

const initial = await readLatest().catch(() => null);
console.log(`[qp-matter] initial reading: ${JSON.stringify(initial)}`);

const airQualityEndpoint = new Endpoint(
    AirQualitySensorDevice.with(
        // Enable every AirQualityEnum bucket - the base cluster only permits
        // Unknown/Good/Poor, but Qingping reports a 5-level status.
        AirQualityServer.with("Fair", "Moderate", "VeryPoor", "ExtremelyPoor"),
        CarbonDioxideConcentrationMeasurementServer.with(NUMERIC),
        Pm25ConcentrationMeasurementServer.with(NUMERIC),
        Pm10ConcentrationMeasurementServer.with(NUMERIC),
        TotalVolatileOrganicCompoundsConcentrationMeasurementServer.with(NUMERIC),
    ),
    {
        id: "airQuality",
        airQuality: { airQuality: airQualityEnum(initial) },
        carbonDioxideConcentrationMeasurement: {
            measuredValue: round1(initial?.co2 ?? null),
            measurementUnit: MeasurementUnit.Ppm,
            measurementMedium: AIR,
        },
        pm25ConcentrationMeasurement: {
            measuredValue: round1(initial?.pm25 ?? null),
            measurementUnit: MeasurementUnit.Ugm3,
            measurementMedium: AIR,
        },
        pm10ConcentrationMeasurement: {
            measuredValue: round1(initial?.pm10 ?? null),
            measurementUnit: MeasurementUnit.Ugm3,
            measurementMedium: AIR,
        },
        totalVolatileOrganicCompoundsConcentrationMeasurement: {
            measuredValue: tvocValue(initial?.tvoc ?? null),
            measurementUnit: tvocUnit,
            measurementMedium: AIR,
        },
    },
);

const temperatureEndpoint = new Endpoint(TemperatureSensorDevice, {
    id: "temperature",
    temperatureMeasurement: {
        measuredValue: centi(initial?.temperature ?? null),
        minMeasuredValue: -4000,
        maxMeasuredValue: 12500,
    },
});

const humidityEndpoint = new Endpoint(HumiditySensorDevice, {
    id: "humidity",
    relativeHumidityMeasurement: {
        measuredValue: centi(initial?.humidity ?? null),
        minMeasuredValue: 0,
        maxMeasuredValue: 10000,
    },
});

const server = await ServerNode.create({
    id: "qp-cgs2",
    network: { port: config.port },
    commissioning: { passcode: config.passcode, discriminator: config.discriminator },
    productDescription: { name: config.productName, deviceType: AirQualitySensorDevice.deviceType },
    basicInformation: {
        vendorName: config.vendorName,
        vendorId: VendorId(config.vendorId),
        productName: config.productName,
        productLabel: config.productName,
        nodeLabel: config.productName,
        productId: config.productId,
        serialNumber: config.serialNumber,
        uniqueId: `qp-cgs2-${config.serialNumber}`,
        hardwareVersion: 2,
        softwareVersion: 1,
    },
});

await server.add(airQualityEndpoint);
await server.add(temperatureEndpoint);
await server.add(humidityEndpoint);

/* -------------------------------------------------------------------------- */
/* update loop                                                               */
/* -------------------------------------------------------------------------- */

let consecutiveFailures = 0;

async function tick() {
    let reading;
    try {
        reading = await readLatest();
    } catch (err) {
        console.error(`[qp-matter] read error: ${err.message}`);
        reading = null;
    }

    if (reading === null) {
        consecutiveFailures++;
        // Keep the last known values for a few misses, then fall back to null.
        if (consecutiveFailures < 3) return;
    } else {
        consecutiveFailures = 0;
    }

    const r = reading ?? {};
    try {
        await Promise.all([
            airQualityEndpoint.set({
                airQuality: { airQuality: airQualityEnum(reading) },
                carbonDioxideConcentrationMeasurement: { measuredValue: round1(r.co2 ?? null) },
                pm25ConcentrationMeasurement: { measuredValue: round1(r.pm25 ?? null) },
                pm10ConcentrationMeasurement: { measuredValue: round1(r.pm10 ?? null) },
                totalVolatileOrganicCompoundsConcentrationMeasurement: {
                    measuredValue: tvocValue(r.tvoc ?? null),
                },
            }),
            temperatureEndpoint.set({ temperatureMeasurement: { measuredValue: centi(r.temperature ?? null) } }),
            humidityEndpoint.set({ relativeHumidityMeasurement: { measuredValue: centi(r.humidity ?? null) } }),
        ]);
        if (reading) {
            console.log(
                `[qp-matter] T=${reading.temperature}C RH=${reading.humidity}% ` +
                    `CO2=${reading.co2}ppm PM2.5=${reading.pm25} PM10=${reading.pm10} ` +
                    `TVOC=${reading.tvoc}ppb age=${reading.ageS}s${reading.stale ? " STALE" : ""}`,
            );
        }
    } catch (err) {
        console.error(`[qp-matter] set() failed: ${err.message}`);
    }
}

const timer = setInterval(() => void tick(), config.pollMs);
server.lifecycle.offline.on(() => clearInterval(timer));
void tick();

for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        console.log(`[qp-matter] ${sig} - shutting down`);
        clearInterval(timer);
        server.close().finally(() => process.exit(0));
    });
}

await server.run();
