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

// heap de convidado para drivers: 9MB a partir de 64MB (longe das imagens
// PE, que carregam em 0x400000+). Alocador de lista livre (estilo K&R) com
// split e coalesce, guardado na propria memoria fisica do convidado.
// Header de bloco (16B): +0 u32 size, +8 u32 next, +12 u32 free.
const GUEST_HEAP_BASE = 0x4000000;
const GUEST_HEAP_SIZE = 0x900000;   // 9MB: 0x4000000..0x48FFFFF
const BLOCK_HEADER_SIZE = 16;

function readBlockSize(address)  { return os.readPhysical32(address); }
function readBlockNext(address)  { return os.readPhysical32(address + 8); }
function readBlockFree(address)  { return os.readPhysical32(address + 12); }
function writeBlock(address, size, next, free) {
    os.writePhysical32(address, size);
    os.writePhysical32(address + 8, next);
    os.writePhysical32(address + 12, free);
}

let guestHeapReady = false;

function initGuestHeap() {
    writeBlock(GUEST_HEAP_BASE, GUEST_HEAP_SIZE - BLOCK_HEADER_SIZE, 0, 1);
    guestHeapReady = true;
}

// aloca `size` bytes alinhados a `align`; retorna endereco fisico ou 0
function guestAllocAligned(size, align) {
    if (!guestHeapReady) initGuestHeap();
    let block = GUEST_HEAP_BASE;
    while (block) {
        if (readBlockFree(block)) {
            const dataStart = block + BLOCK_HEADER_SIZE;
            let aligned = (dataStart + align - 1) & ~(align - 1);
            let padding = aligned - dataStart;
            if (padding > 0 && padding < BLOCK_HEADER_SIZE + 16) {
                // padding pequeno demais p/ bloco livre: pula p/ o proximo
                // alinhamento (padding vira >= BLOCK_HEADER_SIZE+16)
                aligned += align;
                padding += align;
            }
            const available = readBlockSize(block);
            if (available >= padding + size) {
                const oldNext = readBlockNext(block);
                if (padding >= BLOCK_HEADER_SIZE + 16) {
                    // sobra vira um bloco livre antes do bloco alinhado
                    writeBlock(block, padding - BLOCK_HEADER_SIZE, aligned - BLOCK_HEADER_SIZE, 1);
                    writeBlock(aligned - BLOCK_HEADER_SIZE, available - padding, oldNext, 1);
                    block = aligned - BLOCK_HEADER_SIZE;
                }
                const remaining = readBlockSize(block) - size - BLOCK_HEADER_SIZE;
                if (remaining >= 16) {
                    const nextBlock = block + BLOCK_HEADER_SIZE + size;
                    writeBlock(nextBlock, remaining - BLOCK_HEADER_SIZE, readBlockNext(block), 1);
                    writeBlock(block, size, nextBlock, 0);
                } else {
                    writeBlock(block, readBlockSize(block), readBlockNext(block), 0);
                }
                // bloco devolvido sempre zerado (dispatch tables, IRPs...)
                for (let i = 0; i < size; i += 4)
                    os.writePhysical32(block + BLOCK_HEADER_SIZE + i, 0);
                return block + BLOCK_HEADER_SIZE;
            }
        }
        block = readBlockNext(block);
    }
    return 0;   // sem memoria
}

function guestAllocPage()  { return guestAllocAligned(0x1000, 0x1000); }
function guestAllocBytes(size) { return guestAllocAligned(size, 16); }

function guestFreeBytes(pointer) {
    if (!pointer) return;
    const block = pointer - BLOCK_HEADER_SIZE;
    os.writePhysical32(block + 12, 1);
    const next = readBlockNext(block);
    if (next && readBlockFree(next) &&
        block + BLOCK_HEADER_SIZE + readBlockSize(block) === next) {
        writeBlock(block, readBlockSize(block) + BLOCK_HEADER_SIZE + readBlockSize(next),
                   readBlockNext(next), 1);
    }
}

// driver sendo inicializado no momento (entre beginDriver/endDriver)
let currentDriver = null;

// epoch do boot em ms (para KeQueryTickCount)
const bootEpochMs = Date.now();

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

function readUnicodeString(pointer) {
    const charCount = os.readPhysical16(pointer) / 2;
    const buffer = os.readPhysical32(pointer + 8);
    let text = '';
    for (let i = 0; i < charCount; i++)
        text += String.fromCharCode(os.readPhysical16(buffer + i * 2));
    return text;
}

// ---- IRQL: estado real do kernel (PASSIVE=0, APC=1, DISPATCH=2...) ----
let currentIrql = 0;   // PASSIVE_LEVEL

const DISPATCH_LEVEL = 2;

// ---- a tabela de exports (a ORDEM define o id: id real = 32 + indice) ----

const exportNames = [
    'DbgPrint',
    'IoCreateDevice',
    'IoCreateSymbolicLink',
    'IoDeleteDevice',
    'RtlInitUnicodeString',
    'IoCompleteRequest',
    'IoAllocateIrp',
    'IoFreeIrp',
    'RtlCompareUnicodeString',
    'RtlCopyUnicodeString',
    'RtlEqualUnicodeString',
    'KeQuerySystemTime',
    'KeQueryTickCount',
    'MmAllocateNonCachedMemory',
    'MmFreeNonCachedMemory',
    'ExAllocatePoolWithTag',
    'ExFreePool',
    'IoDeleteSymbolicLink',
    'InterlockedIncrement',
    'InterlockedDecrement',
    'InterlockedExchange',
    'InterlockedCompareExchange',
    'KeGetCurrentIrql',
    'KeRaiseIrql',
    'KeLowerIrql',
    'KeInitializeSpinLock',
    'KeAcquireSpinLockRaiseToDpc',
    'KeReleaseSpinLock',
    'RtlInitAnsiString',
    'RtlAnsiStringToUnicodeString',
    'RtlUnicodeStringToAnsiString',
    'RtlFreeAnsiString',
    'RtlFreeUnicodeString',
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
    // IoDeleteDevice(devicePointer): remove o device do namespace
    (devicePointer) => {
        const driverRoot = ObjectManager.lookup('\\Device');
        if (driverRoot && driverRoot.children) {
            for (const child of [...driverRoot.children.values()]) {
                if (child.data && child.data.nativeDevicePointer === devicePointer) {
                    ObjectManager.unlink('\\Device\\' + child.name);
                    return 0;
                }
            }
        }
        return 0;
    },
    // RtlInitUnicodeString(outputPointer, wideStringPointer)
    // semantica real: so aponta o buffer (sem alocar nada)
    (outputPointer, wideStringPointer) => {
        const text = readGuestWideString(wideStringPointer);
        const lengthBytes = text.length * 2;
        os.writePhysical16(outputPointer, lengthBytes);
        os.writePhysical16(outputPointer + 2, lengthBytes + 2);
        os.writePhysical32(outputPointer + 4, 0);
        os.writePhysical32(outputPointer + 8, wideStringPointer >>> 0);
        os.writePhysical32(outputPointer + 12, 0);
        return 0;
    },
    // IoCompleteRequest(ioRequestPointer, priorityBoost)
    (ioRequestPointer, _priorityBoost) => {
        os.writePhysical32(ioRequestPointer + 4, 0);   // status = SUCCESS
        return 0;
    },
    // IoAllocateIrp(stackSize, chargeQuota) -> IRP zerado (pagina do convidado)
    (_stackSize, _chargeQuota) => guestAllocPage(),
    // IoFreeIrp(ioRequestPointer)
    (ioRequestPointer) => { guestFreeBytes(ioRequestPointer); return 0; },
    // RtlCompareUnicodeString(ptrA, ptrB, caseInsensitive) -> <0/0/>0
    (pointerA, pointerB, caseInsensitive) => {
        let a = readUnicodeString(pointerA), b = readUnicodeString(pointerB);
        if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
        return a < b ? -1 : a > b ? 1 : 0;
    },
    // RtlCopyUnicodeString(destPtr, srcPtr)
    // semantica real: copia os chars p/ o buffer do dest (ate MaximumLength)
    (destPointer, srcPointer) => {
        const srcCharCount = os.readPhysical16(srcPointer) / 2;
        const srcBuffer = os.readPhysical32(srcPointer + 8);
        const maxChars = os.readPhysical16(destPointer + 2) / 2;
        let destBuffer = os.readPhysical32(destPointer + 8);
        const copyChars = Math.min(srcCharCount, maxChars);
        if (!destBuffer && maxChars > 0) {
            destBuffer = guestAllocBytes(maxChars * 2);
            os.writePhysical32(destPointer + 8, destBuffer);
            os.writePhysical32(destPointer + 12, 0);
        }
        if (destBuffer)
            for (let i = 0; i < copyChars; i++)
                os.writePhysical16(destBuffer + i * 2, os.readPhysical16(srcBuffer + i * 2));
        os.writePhysical16(destPointer, copyChars * 2);
        return 0;
    },
    // RtlEqualUnicodeString(ptrA, ptrB, caseInsensitive) -> 1/0
    (pointerA, pointerB, caseInsensitive) => {
        let a = readUnicodeString(pointerA), b = readUnicodeString(pointerB);
        if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
        return a === b ? 1 : 0;
    },
    // KeQuerySystemTime(outputPointer u64): intervalos de 100ns desde 1601
    (outputPointer) => {
        const ntTime = (Date.now() + 11644473600000) * 10000;
        os.writePhysical32(outputPointer, ntTime % 0x100000000);
        os.writePhysical32(outputPointer + 4, Math.floor(ntTime / 0x100000000));
        return 0;
    },
    // KeQueryTickCount(outputPointer u64): milissegundos desde o boot
    (outputPointer) => {
        const ticks = Date.now() - bootEpochMs;
        os.writePhysical32(outputPointer, ticks % 0x100000000);
        os.writePhysical32(outputPointer + 4, Math.floor(ticks / 0x100000000));
        return 0;
    },
    // MmAllocateNonCachedMemory(size) -> memoria fisica zerada
    (size) => guestAllocBytes(size),
    // MmFreeNonCachedMemory(pointer, size)
    (pointer, _size) => { guestFreeBytes(pointer); return 0; },
    // ExAllocatePoolWithTag(poolType, size, tag) -> idem (tag ignorada por ora)
    (_poolType, size, _tag) => guestAllocBytes(size),
    // ExFreePool(pointer)
    (pointer) => { guestFreeBytes(pointer); return 0; },
    // IoDeleteSymbolicLink(linkUnicodePtr): remove o link do namespace
    (linkPointer) => {
        const link = readUnicodeString(linkPointer);
        return ObjectManager.unlink(link) ? 0 : 0xC0000009; // STATUS_NOT_FOUND
    },
    // InterlockedIncrement(ptr u32) -> novo valor
    (pointer) => {
        const value = (os.readPhysical32(pointer) + 1) >>> 0;
        os.writePhysical32(pointer, value);
        return value;
    },
    // InterlockedDecrement(ptr u32) -> novo valor
    (pointer) => {
        const value = (os.readPhysical32(pointer) - 1) >>> 0;
        os.writePhysical32(pointer, value);
        return value;
    },
    // InterlockedExchange(ptr u32, value) -> valor antigo
    (pointer, value) => {
        const old = os.readPhysical32(pointer);
        os.writePhysical32(pointer, value >>> 0);
        return old;
    },
    // InterlockedCompareExchange(ptr u32, exchange, comparand) -> valor antigo
    (pointer, exchange, comparand) => {
        const old = os.readPhysical32(pointer);
        if (old === (comparand >>> 0)) os.writePhysical32(pointer, exchange >>> 0);
        return old;
    },
    // KeGetCurrentIrql() -> IRQL atual
    () => currentIrql,
    // KeRaiseIrql(newIrql, outOldPtr) -> sobe; grava o antigo
    (newIrql, outOldPointer) => {
        if (newIrql < currentIrql) {
            os.debugPrint('[ntoskrnl] BUG: KeRaiseIrql p/ nivel menor');
            os.halt();
        }
        if (outOldPointer) os.writePhysical32(outOldPointer, currentIrql);
        currentIrql = newIrql;
        return 0;
    },
    // KeLowerIrql(newIrql)
    (newIrql) => { currentIrql = newIrql; return 0; },
    // KeInitializeSpinLock(ptr u32)
    (pointer) => { os.writePhysical32(pointer, 0); return 0; },
    // KeAcquireSpinLockRaiseToDpc(ptr, outOldIrqlPtr): sobe a DISPATCH + adquire
    (pointer, outOldIrqlPointer) => {
        if (outOldIrqlPointer) os.writePhysical32(outOldIrqlPointer, currentIrql);
        currentIrql = DISPATCH_LEVEL;
        // spin real: test-and-set ate estar livre (single CPU: 1 passada)
        for (;;) {
            const old = os.readPhysical32(pointer);
            if (old === 0) { os.writePhysical32(pointer, 1); return 0; }
        }
    },
    // KeReleaseSpinLock(ptr, oldIrql): libera + volta ao IRQL anterior
    (pointer, oldIrql) => {
        os.writePhysical32(pointer, 0);
        currentIrql = oldIrql;
        return 0;
    },
    // RtlInitAnsiString(outPtr, cstrPtr): aponta o buffer (sem alocar)
    (outputPointer, cStringPointer) => {
        const text = readGuestCString(cStringPointer);
        os.writePhysical16(outputPointer, text.length);
        os.writePhysical16(outputPointer + 2, text.length + 1);
        os.writePhysical32(outputPointer + 4, 0);
        os.writePhysical32(outputPointer + 8, cStringPointer >>> 0);
        os.writePhysical32(outputPointer + 12, 0);
        return 0;
    },
    // RtlAnsiStringToUnicodeString(uniPtr, ansiPtr, allocate)
    (unicodePointer, ansiPointer, allocate) => {
        const ansiBuffer = os.readPhysical32(ansiPointer + 8);
        const text = readGuestCString(ansiBuffer);
        const lengthBytes = text.length * 2;
        let buffer = os.readPhysical32(unicodePointer + 8);
        if (allocate || !buffer) buffer = guestAllocBytes(lengthBytes + 2);
        for (let i = 0; i < text.length; i++)
            os.writePhysical16(buffer + i * 2, text.charCodeAt(i));
        os.writePhysical16(buffer + lengthBytes, 0);
        os.writePhysical16(unicodePointer, lengthBytes);
        os.writePhysical16(unicodePointer + 2, lengthBytes + 2);
        os.writePhysical32(unicodePointer + 4, 0);
        os.writePhysical32(unicodePointer + 8, buffer);
        os.writePhysical32(unicodePointer + 12, 0);
        return 0;
    },
    // RtlUnicodeStringToAnsiString(ansiPtr, uniPtr, allocate)
    (ansiPointer, unicodePointer, allocate) => {
        const text = readUnicodeString(unicodePointer);
        let buffer = os.readPhysical32(ansiPointer + 8);
        if (allocate || !buffer) buffer = guestAllocBytes(text.length + 1);
        for (let i = 0; i < text.length; i++)
            os.writePhysical8(buffer + i, text.charCodeAt(i) & 0xFF);
        os.writePhysical8(buffer + text.length, 0);
        os.writePhysical16(ansiPointer, text.length);
        os.writePhysical16(ansiPointer + 2, text.length + 1);
        os.writePhysical32(ansiPointer + 4, 0);
        os.writePhysical32(ansiPointer + 8, buffer);
        os.writePhysical32(ansiPointer + 12, 0);
        return 0;
    },
    // RtlFreeAnsiString(ptr) / RtlFreeUnicodeString(ptr): libera o buffer
    (pointer) => {
        const buffer = os.readPhysical32(pointer + 8);
        if (buffer) guestFreeBytes(buffer);
        os.writePhysical16(pointer, 0);
        os.writePhysical16(pointer + 2, 0);
        os.writePhysical32(pointer + 8, 0);
        os.writePhysical32(pointer + 12, 0);
        return 0;
    },
    (pointer) => {   // RtlFreeUnicodeString: mesma coisa
        const buffer = os.readPhysical32(pointer + 8);
        if (buffer) guestFreeBytes(buffer);
        os.writePhysical16(pointer, 0);
        os.writePhysical16(pointer + 2, 0);
        os.writePhysical32(pointer + 8, 0);
        os.writePhysical32(pointer + 12, 0);
        return 0;
    },
];

function lookup(dllName, functionName) {
    if (!/^ntoskrnl\.exe$/i.test(dllName)) return -1;
    const index = exportNames.indexOf(functionName);
    return index < 0 ? -1 : 32 + index;
}

// handler chamado pelo C (js_win32_dispatch; id ja sem o offset 32)
function handle(id, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
    const handlerFunction = exportHandlers[id];
    if (!handlerFunction) {
        os.debugPrint('[ntoskrnl] export desconhecido id=' + id);
        return 0;
    }
    return handlerFunction(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
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
        driverObjectPage: driverObjectPage,
        devices: [],
    });
    currentDriver = { name: driverName, node, driverObjectPage, dispatchTablePage };
    return driverObjectPage;
}

function endDriver() { currentDriver = null; }

// descarrega um driver nativo DE VERDADE: chama DriverUnload (se o driver
// registrou uma, em DRIVER_OBJECT+8), remove devices + driver do namespace
// e libera as paginas do driver object
function unloadDriver(driverName) {
    const node = ObjectManager.lookup('\\Driver\\' + driverName);
    if (!node || !node.data.native) return false;
    const driverObjectPage = node.data.driverObjectPage;
    const unloadRoutine = os.readPhysical32(driverObjectPage + 8) +
                          os.readPhysical32(driverObjectPage + 12) * 0x100000000;
    if (unloadRoutine) os.execMsAbi(unloadRoutine, driverObjectPage, 0);
    for (const device of [...node.data.devices])
        ObjectManager.unlink('\\Device\\' + device.name);
    ObjectManager.unlink('\\Driver\\' + driverName);
    guestFreeBytes(driverObjectPage);
    guestFreeBytes(node.data.dispatchTablePointer);
    return true;
}

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

module.exports = { lookup, beginDriver, endDriver, exportNames, loadDriver, unloadDriver };
