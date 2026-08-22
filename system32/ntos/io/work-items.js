// ===========================================================================
// jsOS - system32/ntos/io/work-items.js: Io Work Items (estilo NT).
//
// IoAllocateWorkItem(device) -> item; IoQueueWorkItem(item, routine, type,
// context) enfileira; o kernel drena a fila a PASSIVE_LEVEL (worker thread
// do sistema). IoFreeWorkItem libera.
//
// IO_WORKITEM do convidado no formato interno do NT (ReactOS documenta):
// WORK_QUEUE_ITEM { LIST_ENTRY List; Function } + Context + DeviceObject +
// Type — ver win32/nt-abi.js.
// ===========================================================================

const NtAbi = require('win32/nt-abi');

const WORKITEM = NtAbi.IO_WORKITEM;

const workQueue = [];   // { itemPointer } (campos lidos do IO_WORKITEM real)

function readField(itemPointer, offset) {
    return os.readPhysical32(itemPointer + offset) >>> 0;
}
function writeField(itemPointer, offset, value) {
    os.writePhysical32(itemPointer + offset, value >>> 0);
}

// IoAllocateWorkItem(device): zera o item e liga ao device dono
function createWorkItem(devicePointer, itemPointer) {
    writeField(itemPointer, WORKITEM.LIST_FLINK, 0);
    writeField(itemPointer, WORKITEM.LIST_BLINK, 0);
    writeField(itemPointer, WORKITEM.FUNCTION, 0);
    writeField(itemPointer, WORKITEM.CONTEXT, 0);
    writeField(itemPointer, WORKITEM.DEVICE_OBJECT, devicePointer);
    writeField(itemPointer, WORKITEM.QUEUED, 0);
}

// IoQueueWorkItem(item, routine, queueType, context)
function queueWorkItem(itemPointer, routinePointer, queueType, contextPointer) {
    if (readField(itemPointer, WORKITEM.QUEUED)) return;   // ja na fila
    writeField(itemPointer, WORKITEM.FUNCTION, routinePointer);
    writeField(itemPointer, WORKITEM.CONTEXT, contextPointer);
    writeField(itemPointer, WORKITEM.TYPE, queueType);
    writeField(itemPointer, WORKITEM.QUEUED, 1);
    workQueue.push({ itemPointer });
}

function unqueue(itemPointer) {
    const i = workQueue.findIndex(e => e.itemPointer === itemPointer);
    if (i >= 0) workQueue.splice(i, 1);
    writeField(itemPointer, WORKITEM.QUEUED, 0);
}

// drena a fila a PASSIVE_LEVEL (como as worker threads do NT):
// PIO_WORKITEM_ROUTINE = void (PDEVICE_OBJECT deviceObject, PVOID context)
function runQueue() {
    while (workQueue.length > 0) {
        const entry = workQueue.shift();
        const itemPointer = entry.itemPointer;
        writeField(itemPointer, WORKITEM.QUEUED, 0);
        os.execMsAbi(readField(itemPointer, WORKITEM.FUNCTION),
                     readField(itemPointer, WORKITEM.DEVICE_OBJECT),
                     readField(itemPointer, WORKITEM.CONTEXT));
    }
}

function pending() { return workQueue.length; }

module.exports = { createWorkItem, queueWorkItem, unqueue, runQueue, pending };
