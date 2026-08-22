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
const Lifecycle = require('win32/ntoskrnl/lifecycle');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

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

// PnP real: servico com HardwareId PCI casa com uma funcao enumerada pelo
// bus driver; o AddDevice do driver e' chamado com o PDO (como o NT) e o
// START_DEVICE vai com os recursos de hardware do PDO
function pnpMatchAndAddDevice(serviceName, driverNode) {
    const hardwareId = readString(serviceName, 'HardwareId');
    if (!hardwareId) return;
    const match = hardwareId.match(/VEN_([0-9A-Fa-f]{4})&DEV_([0-9A-Fa-f]{4})/);
    if (!match) return;
    const Pci = require('drivers/bus/pci');
    const pciEntry = Pci.findById(parseInt(match[1], 16), parseInt(match[2], 16));
    if (!pciEntry) {
        os.debugPrint('[pnp] ' + serviceName + ': hardware ' + hardwareId +
                      ' ausente no barramento');
        return;
    }
    const driverObjectPointer = driverNode.data.driverObjectPointer;
    const extensionPointer = GuestMemory.readGuest64(driverObjectPointer +
                                                     NtAbi.DRIVER_OBJECT.DRIVER_EXTENSION);
    const addDeviceRoutine = GuestMemory.readGuest64(extensionPointer +
                                                     NtAbi.DRIVER_EXTENSION.ADD_DEVICE);
    if (!addDeviceRoutine) return;   // driver sem AddDevice: nao e' PnP
    os.debugPrint('[pnp] ' + serviceName + ' -> AddDevice(' + pciEntry.pdoName +
                  ', ' + hardwareId + ')');
    Lifecycle.setCurrentDriverNode(driverNode);
    const status = os.execMsAbi(addDeviceRoutine, driverObjectPointer,
                                pciEntry.node.data.nativeDevicePointer) | 0;
    Lifecycle.endDriver();
    if (status === 0)
        IoManager.pnpStartDevice(pciEntry.node);
    else
        os.debugPrint('[pnp] AddDevice de ' + serviceName + ' falhou: ' + status);
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
                pnpMatchAndAddDevice(name, driverNode);
            }
        } catch (e) {
            os.debugPrint('[services] FALHOU ' + name + ': ' + e.message);
        }
    }
    return loaded;
}

module.exports = { startBootDrivers };
