// ===========================================================================
// jsOS - system32/ntos/cm/services.js: Service Control Manager do kernel.
//
// Le \Registry\Machine\System\Services e carrega os drivers marcados
// Start=0 (boot) ou Start=1 (system) — como o NT faz na fase 1 do boot.
// Depois de cada DriverEntry, o PnP manda IRP_MJ_PNP/IRP_MN_START_DEVICE
// para cada device criado.
// ===========================================================================

const Registry = require('ntos/cm/registry');
const ObjectManager = require('ntos/ob/object-manager');
const IoManager = require('ntos/io/io-manager');
const Ntoskrnl = require('win32/ntoskrnl');

const SERVICES_PATH = '\\Registry\\Machine\\System\\Services';

function readDword(serviceName, valueName) {
    const entry = Registry.readValueByPath(SERVICES_PATH + '\\' + serviceName, valueName);
    if (!entry || entry.data.length < 4) return null;
    return entry.data[0] | (entry.data[1] << 8) | (entry.data[2] << 16) | (entry.data[3] << 24);
}

function readString(serviceName, valueName) {
    const entry = Registry.readValueByPath(SERVICES_PATH + '\\' + serviceName, valueName);
    if (!entry) return null;
    let text = '';
    for (const b of entry.data) { if (!b) break; text += String.fromCharCode(b); }
    return text;
}

// carrega os drivers com Start <= 1 (boot/system), na ordem do Registry
function startBootDrivers() {
    const names = Registry.listKeys(SERVICES_PATH);
    let loaded = 0;
    for (const name of names) {
        const start = readDword(name, 'Start');
        const file = readString(name, 'DriverFile');
        if (start === null || start > 1 || !file) continue;
        os.debugPrint('[services] ' + name + ' -> ' + file);
        try {
            Ntoskrnl.loadDriver('/' + file);
            loaded++;
            // PnP: START_DEVICE para cada device criado por este driver
            const driverNode = ObjectManager.lookup('\\Driver\\' + name);
            if (driverNode) {
                for (const device of driverNode.data.devices)
                    IoManager.pnpStartDevice(device);
            }
        } catch (e) {
            os.debugPrint('[services] FALHOU ' + name + ': ' + e.message);
        }
    }
    return loaded;
}

module.exports = { startBootDrivers };
