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
const IoManager = require('ntos/io/io-manager');
const PeLoader = require('win32/pe-loader');

const DRV = NtAbi.DRIVER_OBJECT;

// driver sendo inicializado no momento (entre beginDriver/endDriver)
let currentDriverNode = null;

// mapa driverObjectPointer -> no do driver (o NT liga o device ao
// DRIVER_OBJECT passado no IoCreateDevice — NAO a um estado ambiente; isso
// suporta carga aninhada de drivers, ex: ZwLoadDriver dentro de DriverEntry)
const nodeByDriverObject = new Map();

function getCurrentDriverNode() { return currentDriverNode; }

// contexto de driver ativo fora do DriverEntry (PnP AddDevice e' chamado
// pelo gerenciador PnP, nao durante o load)
function setCurrentDriverNode(node) { currentDriverNode = node; }

function nodeByDriverObjectPointer(driverObjectPointer) {
    return nodeByDriverObject.get(driverObjectPointer >>> 0) || null;
}

// rotinas de re-inicializacao (IoRegisterDriverReinitialization): rodam
// depois que todos os drivers de boot inicializaram (semantica do NT)
const reinitializationRoutines = [];

function registerReinitialization(routinePointer, contextPointer) {
    reinitializationRoutines.push({ routinePointer, contextPointer });
}

// chamado pelo Service Control ao fim da carga dos boot drivers
function runReinitializationRoutines() {
    while (reinitializationRoutines.length > 0) {
        const entry = reinitializationRoutines.shift();
        os.execMsAbi(entry.routinePointer, 0, entry.contextPointer);
    }
}

function beginDriver(driverName, imageBase, imageSize, entryPoint) {
    const driverObjectPointer = GuestMemory.guestAllocBytes(DRV.STRUCT_SIZE + 0x400);
    const nameBuffer = GuestMemory.guestAllocBytes(driverName.length * 2 + 2);
    const driverExtensionPointer = driverObjectPointer + DRV.STRUCT_SIZE;

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

    // DRIVER_EXTENSION real (wdm.h): o driver registra AddDevice aqui (PnP)
    GuestMemory.writeGuest64(driverObjectPointer + DRV.DRIVER_EXTENSION,
                             driverExtensionPointer);
    GuestMemory.writeGuest64(driverExtensionPointer +
                                 NtAbi.DRIVER_EXTENSION.DRIVER_OBJECT,
                             driverObjectPointer);
    GuestMemory.writeGuest64(driverExtensionPointer +
                                 NtAbi.DRIVER_EXTENSION.ADD_DEVICE, 0);

    currentDriverNode = ObjectManager.createObject('\\Driver', driverName, 'Driver', {
        name: driverName,
        native: true,
        driverObjectPointer,
        exports: {},
        devices: [],
    });
    nodeByDriverObject.set(driverObjectPointer >>> 0, currentDriverNode);
    return driverObjectPointer;
}

function endDriver() { currentDriverNode = null; }

// endereco absoluto de um export do driver (PE export directory, parse real)
function getDriverExport(driverName, exportName) {
    const node = ObjectManager.lookup('\\Driver\\' + driverName);
    if (!node || !node.data.exports) return 0;
    return node.data.exports[exportName] || 0;
}

// carrega um .sys do VFS: PE loader + DriverEntry nativo com o caminho de
// registry do servico (como o NT passa \Registry\Machine\System\Services\X)
function loadDriver(filePath) {    const MemoryFileSystem = require('ntos/fs/memory-file-system');
    const driverBytes = MemoryFileSystem.readBytes(filePath);
    if (!driverBytes) throw new Error('driver nao encontrado: ' + filePath);
    const imageInfo = PeLoader.load(driverBytes);
    const driverName = filePath.split('/').pop().replace(/\.sys$/i, '');
    const driverObjectPointer = beginDriver(driverName, imageInfo.imageBase,
                                            imageInfo.sizeOfImage,
                                            imageInfo.entryPoint);
    currentDriverNode.data.exports = imageInfo.exports;

    // UNICODE_STRING com o caminho do servico (o registryPath real)
    const registryPath = '\\Registry\\Machine\\System\\Services\\' + driverName;
    const pathBuffer = GuestMemory.guestAllocBytes(registryPath.length * 2 + 2);
    GuestStrings.writeGuestWideString(pathBuffer, registryPath);
    const pathStruct = GuestMemory.guestAllocBytes(16);
    GuestMemory.writeGuest16(pathStruct, registryPath.length * 2);
    GuestMemory.writeGuest16(pathStruct + 2, registryPath.length * 2 + 2);
    GuestMemory.writeGuest64(pathStruct + 8, pathBuffer);

    const status = os.execMsAbi(imageInfo.entryPoint, driverObjectPointer,
                                pathStruct);
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
    // PnP primeiro: REMOVE_DEVICE para cada device (como o NT no unload)
    for (const device of [...node.data.devices])
        IoManager.pnpRemoveDevice(device);
    if (unloadRoutine) os.execMsAbi(unloadRoutine, driverObjectPointer, 0);
    for (const device of [...node.data.devices])
        ObjectManager.unlink('\\Device\\' + device.name);
    ObjectManager.unlink('\\Driver\\' + driverName);
    nodeByDriverObject.delete(driverObjectPointer >>> 0);
    GuestMemory.guestFreeBytes(driverObjectPointer);
    return true;
}

// chama o AddDevice registrado pelo driver (DriverExtension->AddDevice) —
// o caminho REAL do PnP manager do NT para instanciar um FDO sobre um PDO
function callAddDevice(driverName, pdoDevicePointer) {
    const node = ObjectManager.lookup('\\Driver\\' + driverName);
    if (!node || !node.data.native) return 0xC0000034 | 0;
    const driverObjectPointer = node.data.driverObjectPointer;
    const extensionPointer = GuestMemory.readGuest64(
        driverObjectPointer + DRV.DRIVER_EXTENSION);
    const addDeviceRoutine = GuestMemory.readGuest64(
        extensionPointer + NtAbi.DRIVER_EXTENSION.ADD_DEVICE);
    if (!addDeviceRoutine) return 0xC0000034 | 0;
    setCurrentDriverNode(node);   // contexto do driver durante o AddDevice
    const status = os.execMsAbi(addDeviceRoutine, driverObjectPointer,
                                pdoDevicePointer);
    endDriver();
    return status | 0;
}

// ---- carga por MODULO (dependencia de import, estilo MmLoadSystemImage) ----
// quando um driver importa de OUTRO .sys (disk.sys -> CLASSPNP.SYS, atapi.sys
// -> ataport.SYS), o loader PE pede o export ao resolvedor de modulos: aqui o
// modulo dependente e' carregado por completo (PE + DriverEntry, como o NT
// faz com as dependencias ANTES do entry do importador) e seu driver node
// fica disponivel para a resolucao do export (endereco nativo direto).
const modulesBeingLoaded = new Set();   // guarda de ciclo (A importa B que importa A)

// chama o DllInitialize(registryPath) do modulo — o initializer DLL-style
// que o loader do NT dispara nos modulos carregados como DEPENDENCIA (o
// DriverEntry de um "kernel DLL" como ataport/classpnp/wmilib e' vazio; a
// inicializacao real — listas globais, EM rules — acontece no DllInitialize)
function callDllInitialize(driverName, exports) {
    const dllInitializeAddress = exports['DllInitialize'];
    if (!dllInitializeAddress) return;
    const registryPath = '\\Registry\\Machine\\System\\Services\\' + driverName;
    const pathBuffer = GuestMemory.guestAllocBytes(registryPath.length * 2 + 2);
    GuestStrings.writeGuestWideString(pathBuffer, registryPath);
    const pathStruct = GuestMemory.guestAllocBytes(16);
    GuestMemory.writeGuest16(pathStruct, registryPath.length * 2);
    GuestMemory.writeGuest16(pathStruct + 2, registryPath.length * 2 + 2);
    GuestMemory.writeGuest64(pathStruct + 8, pathBuffer);
    os.debugPrint('[ntoskrnl] DllInitialize de ' + driverName);
    const status = os.execMsAbi(dllInitializeAddress, pathStruct) | 0;
    if (status !== 0)
        throw new Error('DllInitialize de ' + driverName + ' retornou 0x' +
                        (status >>> 0).toString(16));
}

function ensureModuleDriverLoaded(moduleFileName) {
    const moduleKey = moduleFileName.toLowerCase();
    const driverName = moduleKey.replace(/\.sys$/, '');
    const existingNode = ObjectManager.lookup('\\Driver\\' + driverName);
    if (existingNode) return existingNode;
    if (modulesBeingLoaded.has(moduleKey))
        throw new Error('dependencia circular de driver: ' + moduleFileName);
    modulesBeingLoaded.add(moduleKey);
    try {
        loadDriver('/' + moduleKey);
    } finally {
        modulesBeingLoaded.delete(moduleKey);
    }
    const node = ObjectManager.lookup('\\Driver\\' + driverName);
    if (node) callDllInitialize(driverName, node.data.exports);
    return node;
}

module.exports = { beginDriver, endDriver, loadDriver, unloadDriver,
                   getCurrentDriverNode, setCurrentDriverNode, getDriverExport,
                   nodeByDriverObjectPointer, registerReinitialization,
                   runReinitializationRoutines, callAddDevice,
                   ensureModuleDriverLoaded };
