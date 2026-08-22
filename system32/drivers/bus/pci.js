// ===========================================================================
// jsOS - system32/drivers/bus/pci.js: driver de barramento PCI (estilo
// pci.sys). Enumera o hardware de verdade pelo espaco de configuracao PCI
// (portas 0xCF8/0xCFC), le vendor/device/class/BARs/IRQ de cada funcao e
// cria PDOs (\Device\PDO<N>) com os recursos de hardware REAIS declarados —
// prontos para drivers funcionais nativos anexarem e receberem os recursos
// no IRP_MN_START_DEVICE (Parameters.StartDevice.AllocatedResources).
// ===========================================================================

const ObjectManager = require('ntos/ob/object-manager');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const CONFIG_ADDRESS = 0xCF8;
const CONFIG_DATA = 0xCFC;

// tipos de CM_PARTIAL_RESOURCE_DESCRIPTOR (wdm.h)
const CmResourceType = { PORT: 1, INTERRUPT: 2, MEMORY: 3, DMA: 4 };

function configAddress(bus, device, func, offset) {
    return (0x80000000 | (bus << 16) | (device << 11) | (func << 8) |
            (offset & 0xFC)) >>> 0;
}

function readConfig32(bus, device, func, offset) {
    os.writePort32(CONFIG_ADDRESS, configAddress(bus, device, func, offset));
    return os.readPort32(CONFIG_DATA) >>> 0;
}

function readConfig16(bus, device, func, offset) {
    const value = readConfig32(bus, device, func, offset & 0xFC);
    return (value >>> ((offset & 2) * 8)) & 0xFFFF;
}

// ---- CM_RESOURCE_LIST real (layout wdm.h) em memoria do convidado ---------
// CM_RESOURCE_LIST { u32 Count; CM_FULL_RESOURCE_DESCRIPTOR List[1] }
// FULL { u32 InterfaceType; u32 BusNumber; CM_PARTIAL_RESOURCE_LIST
//   { u16 Version; u16 Revision; u32 Count; CM_PARTIAL_RESOURCE_DESCRIPTOR[] } }
// PARTIAL { u8 Type; u8 Share; u16 Flags; uniao de 16B: Generic/Port/Memory
//   { u64 Start; u32 Length } | Interrupt { u32 Level; u32 Vector; u32 Affinity } }
const FULL_DESCRIPTOR_SIZE = 16;   // InterfaceType + BusNumber + header da lista
const PARTIAL_DESCRIPTOR_SIZE = 20; // Type+Share+Flags + uniao de 16

function buildResourceList(resources) {
    const size = 4 + FULL_DESCRIPTOR_SIZE + PARTIAL_DESCRIPTOR_SIZE * resources.length;
    const address = GuestMemory.guestAllocBytes(size);
    GuestMemory.writeGuest32(address, 1);              // Count de FULL
    GuestMemory.writeGuest32(address + 4, 5);          // InterfaceType = PCIBus
    GuestMemory.writeGuest32(address + 8, 0);          // BusNumber 0
    GuestMemory.writeGuest16(address + 12, 1);         // Version
    GuestMemory.writeGuest16(address + 14, 1);         // Revision
    GuestMemory.writeGuest32(address + 16, resources.length);
    let cursor = address + 20;
    for (const resource of resources) {
        GuestMemory.writeGuest8(cursor, resource.type);
        GuestMemory.writeGuest8(cursor + 1, 0);        // ShareDisposition: exclusive
        GuestMemory.writeGuest16(cursor + 2, resource.flags || 0);
        if (resource.type === CmResourceType.INTERRUPT) {
            GuestMemory.writeGuest32(cursor + 4, resource.level || resource.vector);
            GuestMemory.writeGuest32(cursor + 8, resource.vector);
            GuestMemory.writeGuest32(cursor + 12, resource.affinity || 0xFFFFFFFF);
        } else {
            GuestMemory.writeGuest64(cursor + 4, resource.start);
            GuestMemory.writeGuest32(cursor + 12, resource.length);
        }
        cursor += PARTIAL_DESCRIPTOR_SIZE;
    }
    return address;
}

// ---- enumeracao ------------------------------------------------------------
const devices = [];   // { bus, device, func, vendorId, deviceId, classCode,
                      //   subClass, progIf, irqLine, bars[], node, resourceListPtr }

function enumerate() {
    devices.length = 0;
    let pdoIndex = 0;
    for (let bus = 0; bus < 256; bus++) {
        for (let device = 0; device < 32; device++) {
            for (let func = 0; func < 8; func++) {
                const vendorId = readConfig16(bus, device, func, 0x00);
                if (vendorId === 0xFFFF) continue;
                const deviceId = readConfig16(bus, device, func, 0x02);
                const classReg = readConfig32(bus, device, func, 0x08);
                const irqLine = readConfig32(bus, device, func, 0x3C) & 0xFF;
                const bars = [];
                for (let bar = 0; bar < 6; bar++) {
                    const value = readConfig32(bus, device, func, 0x10 + bar * 4);
                    if (value && value !== 0xFFFFFFFF)
                        bars.push({ index: bar, value });
                }
                devices.push({
                    bus, device, func, vendorId, deviceId,
                    classCode: (classReg >>> 24) & 0xFF,
                    subClass: (classReg >>> 16) & 0xFF,
                    progIf: (classReg >>> 8) & 0xFF,
                    irqLine: irqLine === 0xFF ? 0 : irqLine,
                    bars,
                    node: null,
                    resourceListPointer: 0,
                    pdoName: 'PDO' + pdoIndex++,
                });
            }
        }
    }
    return devices.length;
}

// constroi os recursos de hardware de uma funcao (BARs + IRQ) como no
// CM_RESOURCE_LIST que o PnP entrega no START_DEVICE
function resourcesOf(entry) {
    const resources = [];
    for (const bar of entry.bars) {
        if (bar.value & 1) {   // bit 0 = I/O port
            resources.push({ type: CmResourceType.PORT,
                             start: bar.value & 0xFFFFFFFC, length: 0,
                             flags: 0 });
        } else {               // memoria MMIO
            resources.push({ type: CmResourceType.MEMORY,
                             start: bar.value & 0xFFFFFFF0, length: 0,
                             flags: 0 });
        }
    }
    if (entry.irqLine)
        resources.push({ type: CmResourceType.INTERRUPT,
                         level: entry.irqLine, vector: 0x20 + entry.irqLine,
                         affinity: 0xFFFFFFFF,
                         flags: 0x02 });   // level-triggered
    return resources;
}

// cria os PDOs no namespace com o CM_RESOURCE_LIST pronto — cada PDO tem um
// DEVICE_OBJECT nativo (DriverObject = 0 ate um driver funcional anexar)
function createPdos() {
    const DEVICE = NtAbi.DEVICE_OBJECT;
    for (const entry of devices) {
        const resources = resourcesOf(entry);
        entry.resourceListPointer = buildResourceList(resources);
        const pdoPointer = GuestMemory.guestAllocBytes(DEVICE.STRUCT_SIZE);
        GuestMemory.writeGuest16(pdoPointer + DEVICE.TYPE, DEVICE.IO_TYPE);
        GuestMemory.writeGuest16(pdoPointer + DEVICE.SIZE, DEVICE.STRUCT_SIZE);
        GuestMemory.writeGuest32(pdoPointer + DEVICE.REFERENCE_COUNT, 1);
        GuestMemory.writeGuest8(pdoPointer + DEVICE.STACK_SIZE, 1);
        const node = ObjectManager.createObject('\\Device', entry.pdoName, 'Device', {
            pdo: true,
            pci: entry,
            resources: entry.resourceListPointer,
            nativeDevicePointer: pdoPointer,
        });
        entry.node = node;
    }
}

function init() {
    const count = enumerate();
    createPdos();
    os.debugPrint('[pci] ' + count + ' funcoes PCI enumeradas:');
    for (const e of devices)
        os.debugPrint('[pci]   ' + e.bus + ':' + e.device + '.' + e.func +
                      ' ' + e.vendorId.toString(16).padStart(4, '0') + ':' +
                      e.deviceId.toString(16).padStart(4, '0') +
                      ' classe ' + e.classCode.toString(16).padStart(2, '0') + '.' +
                      e.subClass.toString(16).padStart(2, '0') +
                      (e.irqLine ? ' irq ' + e.irqLine : '') +
                      ' bars=[' + e.bars.map(b => '0x' + b.value.toString(16)).join(',') + ']' +
                      ' -> \\Device\\' + e.pdoName);
    return count;
}

// procura uma funcao por vendor/device id (para drivers funcionais)
function findById(vendorId, deviceId) {
    return devices.find(e => e.vendorId === vendorId && e.deviceId === deviceId) || null;
}

module.exports = { init, findById, devices, CmResourceType };
