// ===========================================================================
// jsOS - system32/win32/ntoskrnl/lifecycle.js: ciclo de vida de drivers .sys
// com o DRIVER_OBJECT REAL do NT (offsets em win32/nt-abi.js):
//   Type=IO_TYPE_DRIVER, Size, DriverStart/Size, DriverName, DriverInit,
//   MajorFunction[] zerado, DriverUnload lido do offset real.
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const ObjectManager = require('ntos/ob/object-manager');
const PeLoader = require('win32/pe-loader');

const DRV = NtAbi.DRIVER_OBJECT;

// driver sendo inicializado no momento (entre beginDriver/endDriver)
let currentDriverNode = null;

function getCurrentDriverNode() { return currentDriverNode; }

function beginDriver(driverName, imageBase, imageSize, entryPoint) {
    const driverObjectPointer = GuestMemory.guestAllocBytes(DRV.STRUCT_SIZE + 0x400);
    const nameBuffer = GuestMemory.guestAllocBytes(driverName.length * 2 + 2);

    GuestStrings.writeGuestWideString(nameBuffer, driverName);

    GuestMemory.writeGuest16(driverObjectPointer + DRV.TYPE, DRV.IO_TYPE);
    GuestMemory.writeGuest16(driverObjectPointer + DRV.SIZE, DRV.STRUCT_SIZE);
    GuestMemory.writeGuest32(driverObjectPointer + DRV.DEVICE_OBJECT, 0);
    GuestMemory.writeGuest32(driverObjectPointer + DRV.DRIVER_START, imageBase >>> 0);
    GuestMemory.writeGuest32(driverObjectPointer + DRV.DRIVER_SIZE, imageSize);
    GuestMemory.writeGuest16(driverObjectPointer + DRV.DRIVER_NAME + 0,
                             driverName.length * 2);
    GuestMemory.writeGuest16(driverObjectPointer + DRV.DRIVER_NAME + 2,
                             driverName.length * 2 + 2);
    GuestMemory.writeGuest32(driverObjectPointer + DRV.DRIVER_NAME + 8,
                             nameBuffer >>> 0);
    GuestMemory.writeGuest32(driverObjectPointer + DRV.DRIVER_NAME + 12, 0);
    GuestMemory.writeGuest64(driverObjectPointer + DRV.DRIVER_INIT, entryPoint);
    GuestMemory.writeGuest64(driverObjectPointer + DRV.DRIVER_UNLOAD, 0);

    currentDriverNode = ObjectManager.createObject('\\Driver', driverName, 'Driver', {
        name: driverName,
        native: true,
        driverObjectPointer,
        exports: {},
        devices: [],
    });
    return driverObjectPointer;
}

function endDriver() { currentDriverNode = null; }

// endereco absoluto de um export do driver (PE export directory, parse real)
function getDriverExport(driverName, exportName) {
    const node = ObjectManager.lookup('\\Driver\\' + driverName);
    if (!node || !node.data.exports) return 0;
    return node.data.exports[exportName] || 0;
}

// carrega um .sys do VFS: PE loader + DriverEntry nativo
function loadDriver(filePath) {
    const MemoryFileSystem = require('ntos/fs/memory-file-system');
    const driverBytes = MemoryFileSystem.readBytes(filePath);
    if (!driverBytes) throw new Error('driver nao encontrado: ' + filePath);
    const imageInfo = PeLoader.load(driverBytes);
    const driverName = filePath.split('/').pop().replace(/\.sys$/i, '');
    const driverObjectPointer = beginDriver(driverName, imageInfo.imageBase,
                                            imageInfo.sizeOfImage,
                                            imageInfo.entryPoint);
    currentDriverNode.data.exports = imageInfo.exports;
    const status = os.execMsAbi(imageInfo.entryPoint, driverObjectPointer, 0);
    endDriver();
    if (status !== 0) throw new Error('DriverEntry de ' + driverName +
                                      ' retornou ' + status);
    return true;
}

// descarrega DE VERDADE: DriverUnload (se registrada), remove devices+driver
// do namespace e libera a memoria do driver object. Como no NT, RECUSA o
// unload se algum device do driver tiver referencias vivas (handles abertos).
function unloadDriver(driverName) {
    const node = ObjectManager.lookup('\\Driver\\' + driverName);
    if (!node || !node.data.native) return false;
    for (const device of node.data.devices) {
        const devicePointer = device.data.nativeDevicePointer;
        const refCount = GuestMemory.readGuest32(devicePointer +
                                                 NtAbi.DEVICE_OBJECT.REFERENCE_COUNT) | 0;
        if (refCount > 1) {
            os.debugPrint('[ntoskrnl] unload de ' + driverName +
                          ' RECUSADO: \\Device\\' + device.name +
                          ' tem ' + (refCount - 1) + ' handle(s) aberto(s)');
            return false;
        }
    }
    const driverObjectPointer = node.data.driverObjectPointer;
    const unloadRoutine = GuestMemory.readGuest64(driverObjectPointer + DRV.DRIVER_UNLOAD);
    if (unloadRoutine) os.execMsAbi(unloadRoutine, driverObjectPointer, 0);
    for (const device of [...node.data.devices])
        ObjectManager.unlink('\\Device\\' + device.name);
    ObjectManager.unlink('\\Driver\\' + driverName);
    GuestMemory.guestFreeBytes(driverObjectPointer);
    return true;
}

module.exports = { beginDriver, endDriver, loadDriver, unloadDriver,
                   getCurrentDriverNode, getDriverExport };
