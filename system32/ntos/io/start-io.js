// ===========================================================================
// jsOS - system32/ntos/io/start-io.js: o modelo StartIo do NT (packetized
// I/O serializado por device).
//
// IoStartPacket(device, irp, key, cancelRoutine): se o device esta livre,
// vira CurrentIrp e a rotina DriverStartIo do DRIVER_OBJECT roda na hora;
// senao o IRP entra na KDEVICE_QUEUE do DEVICE_OBJECT ordenado pela chave
// (insertion sort por key crescente, como o NT). IoStartNextPacket tira o
// proximo da fila e dispara. A fila e' a LIST_ENTRY real do DEVICE_OBJECT —
// os links ficam na memoria do convidado (IRP.Tail.Overlay.ListEntry @0x70).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const DEV = NtAbi.DEVICE_OBJECT;
const DRV = NtAbi.DRIVER_OBJECT;
const DQ = NtAbi.KDEVICE_QUEUE;
const LIST_IN_IRP = 0x70;   // IRP.Tail.Overlay.ListEntry (Flink/Blink) wdm.h
const KEY_IN_IRP = 0x80;    // IRP.Tail.Overlay.DriverContext[0] guarda a key

function readGuest32(a) { return os.readPhysical32(a) >>> 0; }
function readGuest64(a) {
    return os.readPhysical32(a) + os.readPhysical32(a + 4) * 0x100000000;
}
function writeGuest32(a, v) { os.writePhysical32(a, v >>> 0); }
function writeGuest64(a, v) {
    os.writePhysical32(a, v >>> 0);
    os.writePhysical32(a + 4, Math.floor(v / 0x100000000) >>> 0);
}

function queueHead(devicePointer) { return devicePointer + DEV.DEVICE_QUEUE; }

function queueInitialize(devicePointer) {
    const queuePointer = queueHead(devicePointer);
    writeGuest32(queuePointer + DQ.TYPE,
                 DQ.TYPE_DEVICE_QUEUE | (DQ.SIZE << 16));
    writeGuest32(queuePointer + DQ.LOCK, 0);
    writeGuest32(queuePointer + DQ.LOCK + 4, 0);
    os.writePhysical8(queuePointer + DQ.BUSY, 0);
    // LIST_ENTRY circular vazia aponta p/ si mesma (sentinela)
    writeGuest64(queuePointer + DQ.ENTRY, queuePointer + DQ.ENTRY);
    writeGuest64(queuePointer + DQ.ENTRY + 8, queuePointer + DQ.ENTRY);
}

// chama DriverStartIo(device, irp) do driver dono do device
function callStartIo(devicePointer, irpPointer) {
    const driverObjectPointer = readGuest64(devicePointer + DEV.DRIVER_OBJECT);
    const startIoRoutine = readGuest64(driverObjectPointer + DRV.DRIVER_START_IO);
    if (!startIoRoutine) return;   // driver sem StartIo: nada a disparar
    os.execMsAbi(startIoRoutine, devicePointer, irpPointer, 0);
}

// garante a KDEVICE_QUEUE inicializada (LIST circular vazia). Drivers que
// serializam pelo CONTROLLER_OBJECT (i8042) nunca chamam KeInitializeDeviceQueue
// e a fila nasce zerada — tratar zeros como "vazia" (como a lista vazia real)
function queueEnsureInitialized(devicePointer) {
    const queuePointer = queueHead(devicePointer);
    if (readGuest64(queuePointer + DQ.ENTRY) === 0) queueInitialize(devicePointer);
}

// IoStartPacket(device, irp, keyPtr(ou key), cancelRoutine)
// WDM real: key e' um PULONG (opcional); cancelRoutine pode ser NULL.
function ioStartPacket(devicePointer, irpPointer, sortKey, cancelRoutine) {
    queueEnsureInitialized(devicePointer);
    const queuePointer = queueHead(devicePointer);
    // a key chega como ponteiro p/ ULONG (assinatura WDM) ou 0
    const key = sortKey ? readGuest32(sortKey >>> 0) : 0xFFFFFFFF;
    writeGuest64(irpPointer + KEY_IN_IRP, key);
    if (readGuest64(devicePointer + DEV.CURRENT_IRP) === 0 &&
        os.readPhysical8(queuePointer + DQ.BUSY) === 0) {
        os.writePhysical8(queuePointer + DQ.BUSY, 1);
        writeGuest64(devicePointer + DEV.CURRENT_IRP, irpPointer);
        callStartIo(devicePointer, irpPointer);
        return;
    }
    // ocupado: insere na fila ORDENADO pela key (insertion sort, como o NT)
    const entry = irpPointer + LIST_IN_IRP;
    let cursor = readGuest64(queuePointer + DQ.ENTRY);        // Flink
    while (cursor !== queuePointer + DQ.ENTRY) {
        const cursorIrp = cursor - LIST_IN_IRP;
        if (readGuest64(cursorIrp + KEY_IN_IRP) > key) break;
        cursor = readGuest64(cursor);                          // proximo Flink
    }
    // insere `entry` antes de `cursor`: entry->Flink=cursor,
    // entry->Blink=cursor->Blink; ajusta os vizinhos
    const blink = readGuest64(cursor + 8);
    writeGuest64(entry, cursor);
    writeGuest64(entry + 8, blink);
    writeGuest64(blink, entry);
    writeGuest64(cursor + 8, entry);
}

// IoStartNextPacket(device, cancelable): tira o primeiro da fila e dispara
function ioStartNextPacket(devicePointer, _cancelable) {
    queueEnsureInitialized(devicePointer);
    const queuePointer = queueHead(devicePointer);
    const head = queuePointer + DQ.ENTRY;
    const first = readGuest64(head);                           // Flink
    writeGuest64(devicePointer + DEV.CURRENT_IRP, 0);
    if (first === head) {                                      // fila vazia
        os.writePhysical8(queuePointer + DQ.BUSY, 0);
        return;
    }
    // remove `first` da lista
    const firstFlink = readGuest64(first);
    const firstBlink = readGuest64(first + 8);
    writeGuest64(firstBlink, firstFlink);
    writeGuest64(firstFlink + 8, firstBlink);
    const nextIrp = first - LIST_IN_IRP;
    writeGuest64(devicePointer + DEV.CURRENT_IRP, nextIrp);
    callStartIo(devicePointer, nextIrp);
}

// IoSetStartIoAttributes(device, deferredStart, serialAccess): flags reais
// do DEVICE_OBJECT (no NT moram no device extension extension; aqui ficam
// no campo de caracteristicas altas — nao colidem com FILE_* baixos)
function ioSetStartIoAttributes(devicePointer, deferredStartIo, serialAccess) {
    let attributes = readGuest32(devicePointer + DEV.CHARACTERISTICS);
    attributes &= 0xFFFF;   // preserva os bits FILE_* baixos
    if (deferredStartIo) attributes |= 0x10000;     // bit interno jsOS
    if (serialAccess)    attributes |= 0x20000;     // bit interno jsOS
    writeGuest32(devicePointer + DEV.CHARACTERISTICS, attributes);
}

module.exports = { queueInitialize, ioStartPacket, ioStartNextPacket,
                   ioSetStartIoAttributes };
