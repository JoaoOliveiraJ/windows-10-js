// ===========================================================================
// jsOS - system32/win32/ntoskrnl.js: tabela de exports do "ntoskrnl" em JS.
//
// Drivers .sys (PE nativo) importam de ntoskrnl.exe; o loader PE resolve
// contra esta tabela (ids 32-63 do trampolim; o C roteia id>=32 para ca).
// Handlers recebem ponteiros do convidado (memoria fisica identity-mapped).
//
// ABI de structs do convidado (nosso subconjunto estilo NT, documentado):
//   DRIVER_OBJECT: +0 u64 dispatchTablePointer (8 slots por IRP_MJ)
//   DEVICE_OBJECT: +0 u64 driverObjectPointer
//   IRP: +0 u32 majorFunction, +4 u32 status, +8 u64 bufferPointer,
//        +16 u64 bufferLength, +24 u64 resultLength (saida)
//   UNICODE_STRING: +0 u16 length, +2 u16 maximumLength, +8 u64 bufferPointer
// ===========================================================================

const ObjectManager = require('ntos/ob/object-manager');
const IoManager = require('ntos/io/io-manager');

// heap de convidado para drivers: paginas de 4KB a partir de 6MB
const GUEST_HEAP_BASE = 0x600000;
let guestHeapNext = GUEST_HEAP_BASE;

function guestAllocPage() {
    const page = guestHeapNext;
    guestHeapNext += 0x1000;
    for (let i = 0; i < 0x1000; i += 4) os.writePhysical32(page + i, 0);
    return page;
}

// driver sendo inicializado no momento (entre beginDriver/endDriver)
let currentDriver = null;

// ---- leitura/escrita de strings do convidado ----

function readGuestCString(address) {
    let text = '';
    for (let b = os.readPhysical8(address); b !== 0; b = os.readPhysical8(++address))
        text += String.fromCharCode(b);
    return text;
}

function readGuestWideString(address) {
    let text = '';
    for (let w = os.readPhysical16(address); w !== 0; w = os.readPhysical16(address += 2))
        text += String.fromCharCode(w);
    return text;
}

function writeGuestBytes(address, bytes) {
    for (let i = 0; i < bytes.length; i++) os.writePhysical8(address + i, bytes[i]);
}

function writeUnicodeString(outputPointer, text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        bytes.push(text.charCodeAt(i) & 0xFF, (text.charCodeAt(i) >> 8) & 0xFF);
    }
    bytes.push(0, 0);
    const bufferPage = guestAllocPage();
    writeGuestBytes(bufferPage, bytes);
    os.writePhysical16(outputPointer, text.length * 2);
    os.writePhysical16(outputPointer + 2, text.length * 2 + 2);
    os.writePhysical32(outputPointer + 4, 0);
    os.writePhysical32(outputPointer + 8, bufferPage);
    os.writePhysical32(outputPointer + 12, 0);
}

function readUnicodeString(pointer) {
    const charCount = os.readPhysical16(pointer) / 2;
    const buffer = os.readPhysical32(pointer + 8);
    let text = '';
    for (let i = 0; i < charCount; i++)
        text += String.fromCharCode(os.readPhysical16(buffer + i * 2));
    return text;
}

// ---- a tabela de exports (a ORDEM define o id: id real = 32 + indice) ----

const exportNames = [
    'DbgPrint',
    'IoCreateDevice',
    'IoCreateSymbolicLink',
    'IoDeleteDevice',
    'RtlInitUnicodeString',
    'IoCompleteRequest',
];

const exportHandlers = [
    // DbgPrint(formatPointer): texto do convidado -> serial
    (formatPointer) => {
        const text = readGuestCString(formatPointer);
        os.debugPrint('[driver] ' + text.replace(/\r?\n$/, ''));
        return 0;
    },
    // IoCreateDevice(driverObject, extSize, nameUnicodePtr, type, chars, exclusive, outPtr)
    (driverObjectPointer, _extSize, namePointer, _type, _chars, _exclusive, outputPointer) => {
        const deviceName = namePointer ? readUnicodeString(namePointer) : null;
        // IoCreateDevice recebe o caminho completo ("\Device\Echo"); o no
        // no namespace usa so o nome curto
        const shortName = deviceName ? deviceName.replace(/^\\Device\\/i, '') : 'Unnamed';
        const devicePage = guestAllocPage();
        os.writePhysical32(devicePage, driverObjectPointer >>> 0);   // +0: driverObject
        if (currentDriver) {
            const deviceNode = IoManager.createDevice(currentDriver.node, shortName);
            deviceNode.data.nativeDevicePointer = devicePage;
        }
        os.writePhysical32(outputPointer, devicePage >>> 0);
        os.writePhysical32(outputPointer + 4, 0);
        return 0;   // STATUS_SUCCESS
    },
    // IoCreateSymbolicLink(linkUnicodePtr, targetUnicodePtr)
    (linkPointer, targetPointer) => {
        ObjectManager.createSymlink(readUnicodeString(linkPointer),
                                    readUnicodeString(targetPointer));
        return 0;
    },
    // IoDeleteDevice(devicePointer)
    (_devicePointer) => 0,   // toy: sem remocao de namespace ainda
    // RtlInitUnicodeString(outputPointer, wideStringPointer)
    (outputPointer, wideStringPointer) => {
        writeUnicodeString(outputPointer, readGuestWideString(wideStringPointer));
        return 0;
    },
    // IoCompleteRequest(ioRequestPointer, priorityBoost)
    (ioRequestPointer, _priorityBoost) => {
        os.writePhysical32(ioRequestPointer + 4, 0);   // status = SUCCESS
        return 0;
    },
];

function lookup(dllName, functionName) {
    if (!/^ntoskrnl\.exe$/i.test(dllName)) return -1;
    const index = exportNames.indexOf(functionName);
    return index < 0 ? -1 : 32 + index;
}

// handler chamado pelo C (js_win32_dispatch; id ja sem o offset 32)
function handle(id, arg1, arg2, arg3, arg4) {
    const handlerFunction = exportHandlers[id];
    if (!handlerFunction) {
        os.debugPrint('[ntoskrnl] export desconhecido id=' + id);
        return 0;
    }
    return handlerFunction(arg1, arg2, arg3, arg4);
}

// ---- ciclo de vida do driver nativo ----

function beginDriver(driverName) {
    const driverObjectPage = guestAllocPage();     // DRIVER_OBJECT
    const dispatchTablePage = guestAllocPage();    // tabela de dispatch
    os.writePhysical32(driverObjectPage, dispatchTablePage >>> 0);
    os.writePhysical32(driverObjectPage + 4, 0);
    const node = ObjectManager.createObject('\\Driver', driverName, 'Driver', {
        name: driverName,
        native: true,
        dispatchTablePointer: dispatchTablePage,
        devices: [],
    });
    currentDriver = { name: driverName, node, driverObjectPage, dispatchTablePage };
    return driverObjectPage;
}

function endDriver() { currentDriver = null; }

// carrega um .sys do VFS: PE loader + DriverEntry nativo
function loadDriver(filePath) {
    const MemoryFileSystem = require('ntos/fs/memory-file-system');
    const PeLoader = require('win32/pe-loader');
    const driverBytes = MemoryFileSystem.readBytes(filePath);
    if (!driverBytes) throw new Error('driver nao encontrado: ' + filePath);
    const entryPoint = PeLoader.load(driverBytes);
    const driverName = filePath.split('/').pop().replace(/\.sys$/i, '');
    const driverObjectPointer = beginDriver(driverName);
    const status = os.execMsAbi(entryPoint, driverObjectPointer, 0);
    endDriver();
    if (status !== 0) throw new Error('DriverEntry retornou ' + status);
    return true;
}

// o C (js_win32_dispatch) procura globalThis.Ntoskrnl.handle
globalThis.Ntoskrnl = { handle };

module.exports = { lookup, beginDriver, endDriver, exportNames, loadDriver };
