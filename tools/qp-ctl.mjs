#!/usr/bin/env node
/**
 * qp-ctl - minimal matter.js controller for bringing up the CGS2 Matter node.
 *
 * This is the "first fabric". It commissions the device on-network (no BLE),
 * lets you verify the sensor attributes, and then opens a commissioning window
 * so Apple Home (or anything else) can join as a second admin - that second
 * join happens over IP, so no BLE stack is ever needed on the device.
 *
 *   npm install                       # in this tools/ dir
 *   node qp-ctl.mjs commission        # pair (uses passcode 20202021 / disc 3840)
 *   node qp-ctl.mjs read              # dump the air-quality attributes
 *   node qp-ctl.mjs open-window       # -> prints a pairing code for Apple Home
 *   node qp-ctl.mjs decommission      # remove this controller's fabric
 *
 * Options (env or --flag=value):
 *   QP_PASSCODE (20202021)  QP_DISCRIMINATOR (3840)
 *   QP_NODE_ID              specific node id for read/open-window/decommission
 *   --window-seconds=900    open-window duration
 *
 * Controller state is kept in tools/.matter-ctl/ - keep it if you want to be
 * able to re-open the window later; delete it to start fresh.
 */

import { Environment, Logger } from "@matter/main";
import { AirQualityClient } from "@matter/main/behaviors/air-quality";
import { CarbonDioxideConcentrationMeasurementClient } from "@matter/main/behaviors/carbon-dioxide-concentration-measurement";
import { Pm10ConcentrationMeasurementClient } from "@matter/main/behaviors/pm10-concentration-measurement";
import { Pm25ConcentrationMeasurementClient } from "@matter/main/behaviors/pm25-concentration-measurement";
import { RelativeHumidityMeasurementClient } from "@matter/main/behaviors/relative-humidity-measurement";
import { TemperatureMeasurementClient } from "@matter/main/behaviors/temperature-measurement";
import { TotalVolatileOrganicCompoundsConcentrationMeasurementClient } from "@matter/main/behaviors/total-volatile-organic-compounds-concentration-measurement";
import { BasicInformationCluster, GeneralCommissioning } from "@matter/main/clusters";
import { CommissioningController } from "@project-chip/matter.js";

Logger.level = process.env.QP_LOG_LEVEL ?? "info";

const env = Environment.default;
const arg = (name, dflt) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
};

const CMD = process.argv[2];
const PASSCODE = Number(process.env.QP_PASSCODE ?? 20202021);
const DISCRIMINATOR = Number(process.env.QP_DISCRIMINATOR ?? 3840);
// Matter caps the commissioning-window timeout at 900s (and floors it at 180s).
const WINDOW_SECONDS = Math.min(900, Math.max(180, Number(arg("window-seconds", 900))));
const WANT_NODE = process.env.QP_NODE_ID ? BigInt(process.env.QP_NODE_ID) : undefined;
// Optional: skip mDNS discovery for the initial PASE by giving the device address
// directly. Useful where the host's mDNS stack (e.g. macOS) doesn't cooperate
// with matter.js. Format: --ip=192.168.1.189  (port defaults to 5540).
const KNOWN_IP = arg("ip", process.env.QP_IP);
const KNOWN_PORT = Number(arg("port", process.env.QP_PORT ?? 5540));

// Pin controller storage next to this script.
env.vars.set("storage.path", new URL(".matter-ctl", import.meta.url).pathname);

let CTRL;
async function makeController() {
    CTRL = new CommissioningController({
        environment: { environment: env, id: "qp-ctl" },
        autoConnect: false,
        adminFabricLabel: "qp-ctl (CGS2 bring-up)",
    });
    await CTRL.start();
    return CTRL;
}

/** Close the controller storage cleanly, then exit. Never hang on shutdown. */
async function done(code = 0) {
    const hardExit = setTimeout(() => process.exit(code), 4000);
    hardExit.unref?.();
    try {
        await CTRL?.close();
    } catch {
        /* ignore */
    }
    process.exit(code);
}

async function pickNode(controller) {
    const nodes = controller.getCommissionedNodes();
    if (!nodes.length) throw new Error("no commissioned nodes - run 'commission' first");
    const id = WANT_NODE ?? nodes[0];
    if (!nodes.map(String).includes(String(id))) throw new Error(`node ${id} not commissioned (have ${nodes})`);
    const node = await controller.getNode(id);
    if (!node.isConnected) node.connect();
    if (!node.initialized) await node.events.initialized;
    return { id, node };
}

function scaled(v, f) {
    return v === undefined || v === null ? null : v / f;
}

async function cmdCommission() {
    const controller = await makeController();
    if (controller.getCommissionedNodes().length) {
        console.log("already commissioned:", controller.getCommissionedNodes().map(String));
        console.log("run 'decommission' first if you want to re-pair.");
        return void (await done(0));
    }
    console.log(`Commissioning on-network (passcode ${PASSCODE}, discriminator ${DISCRIMINATOR}) ...`);
    if (KNOWN_IP) console.log(`  (using known address ${KNOWN_IP}:${KNOWN_PORT}, skipping mDNS for PASE)`);
    const nodeId = await controller.commissionNode({
        commissioning: {
            regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
            regulatoryCountryCode: "XX",
        },
        discovery: {
            knownAddress: KNOWN_IP ? { ip: KNOWN_IP, port: KNOWN_PORT, type: "udp" } : undefined,
            identifierData: { longDiscriminator: DISCRIMINATOR },
            discoveryCapabilities: { ble: false, onIpNetwork: true },
        },
        passcode: PASSCODE,
    });
    console.log(`\n  commissioned OK -> nodeId ${nodeId}\n`);
    await cmdReadWith(controller, nodeId);
    await done(0);
}

async function cmdRead() {
    const controller = await makeController();
    await cmdReadWith(controller, (await pickNode(controller)).id);
    await done(0);
}

async function cmdReadWith(controller, nodeId) {
    const node = await controller.getNode(nodeId);
    if (!node.isConnected) node.connect();
    if (!node.initialized) await node.events.initialized;
    // Let the initial autosubscribe settle so stateOf() doesn't race the
    // subscription write transaction.
    await new Promise(r => setTimeout(r, 2500));

    const info = node.getRootClusterClient(BasicInformationCluster);
    if (info) {
        console.log("BasicInformation:");
        console.log("  vendor       ", await info.getVendorNameAttribute());
        console.log("  product      ", await info.getProductNameAttribute());
        console.log("  serialNumber ", await info.getSerialNumberAttribute().catch(() => "n/a"));
    }

    // ep1 = Air Quality Sensor, ep2 = Temperature Sensor, ep3 = Humidity Sensor.
    const aqEp = node.parts.get(1);
    const tEp = node.parts.get(2);
    const hEp = node.parts.get(3);
    if (!aqEp) throw new Error("endpoint 1 (AirQualitySensor) not found");

    const stateOf = (ep, client) => {
        try {
            return ep?.stateOf(client);
        } catch {
            return undefined;
        }
    };
    const aq = stateOf(aqEp, AirQualityClient);
    const co2 = stateOf(aqEp, CarbonDioxideConcentrationMeasurementClient);
    const pm25 = stateOf(aqEp, Pm25ConcentrationMeasurementClient);
    const pm10 = stateOf(aqEp, Pm10ConcentrationMeasurementClient);
    const tvoc = stateOf(aqEp, TotalVolatileOrganicCompoundsConcentrationMeasurementClient);
    const t = stateOf(tEp, TemperatureMeasurementClient);
    const h = stateOf(hEp, RelativeHumidityMeasurementClient);

    console.log("\nAirQualitySensor (ep1):");
    console.log("  airQuality       ", aq?.airQuality);
    console.log("  co2          ppm ", co2?.measuredValue, `(unit=${co2?.measurementUnit})`);
    console.log("  pm2.5        ug/m3", pm25?.measuredValue, `(unit=${pm25?.measurementUnit})`);
    console.log("  pm10         ug/m3", pm10?.measuredValue, `(unit=${pm10?.measurementUnit})`);
    console.log("  tvoc             ", tvoc?.measuredValue, `(unit=${tvoc?.measurementUnit})`);
    console.log("TemperatureSensor (ep2):");
    console.log("  temperature  C   ", scaled(t?.measuredValue, 100));
    console.log("HumiditySensor (ep3):");
    console.log("  humidity     %   ", scaled(h?.measuredValue, 100));
    return { id: nodeId };
}

async function cmdOpenWindow() {
    const controller = await makeController();
    const { id, node } = await pickNode(controller);
    console.log(`Opening enhanced commissioning window on node ${id} for ${WINDOW_SECONDS}s ...`);
    const { qrPairingCode, manualPairingCode } = await node.openEnhancedCommissioningWindow(WINDOW_SECONDS);
    console.log("\n============================================================");
    console.log("  Add to Apple Home:  Add Accessory -> More options -> ");
    console.log("  enter this code (device is found over Wi-Fi, no BLE):");
    console.log(`\n     MANUAL PAIRING CODE:  ${manualPairingCode}\n`);
    console.log(`  QR: https://project-chip.github.io/connectedhomeip/qrcode.html?data=${qrPairingCode}`);
    console.log("============================================================\n");
    console.log(`Window is open for ${WINDOW_SECONDS}s. Leave this running until Apple Home finishes.`);
    setTimeout(() => done(0), (WINDOW_SECONDS + 15) * 1000);
}

async function cmdDecommission() {
    const controller = await makeController();
    const { id, node } = await pickNode(controller);
    console.log(`Decommissioning node ${id} (removing this controller's fabric) ...`);
    await node.decommission();
    console.log("done.");
    await done(0);
}

async function cmdNodes() {
    const controller = await makeController();
    console.log("commissioned nodes:", controller.getCommissionedNodes().map(String));
    for (const d of controller.getCommissionedNodesDetails()) {
        console.log(" ", JSON.stringify(d, (k, v) => (typeof v === "bigint" ? String(v) : v)));
    }
    await done(0);
}

const table = {
    commission: cmdCommission,
    read: cmdRead,
    "open-window": cmdOpenWindow,
    decommission: cmdDecommission,
    nodes: cmdNodes,
};

if (!table[CMD]) {
    console.log("usage: qp-ctl.mjs <commission|read|open-window|decommission|nodes>");
    process.exit(2);
}
table[CMD]().catch(async err => {
    console.error(err);
    await done(1);
});
