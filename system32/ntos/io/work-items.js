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

// work items do proprio kernel JS (rotina JS em vez de codigo nativo —
// maquinaria interna, ex: IoReportTargetDeviceChangeAsynchronous)
const jsRoutineByItem = new Map();   // itemPointer -> funcao JS

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
    queueWorkItemEx(itemPointer, routinePointer, queueType, contextPointer, false);
}

// variante interna: rotina JS (uso do proprio kernel, nao de drivers)
function queueJsWorkItem(itemPointer, jsFunction, contextPointer) {
    jsRoutineByItem.set(itemPointer >>> 0, jsFunction);
    queueWorkItemEx(itemPointer, 0, 1 /* DelayedWorkQueue */, contextPointer,
                    false);
}

// IoQueueWorkItemEx: routine e' IO_WORKITEM_ROUTINE_EX — (ioObject, context,
// ioWorkItem), 3 args (bit alto do Type marca a convencao Ex)
function queueWorkItemEx(itemPointer, routinePointer, queueType, contextPointer,
                         isEx) {
    if (readField(itemPointer, WORKITEM.QUEUED)) return;   // ja na fila
    writeField(itemPointer, WORKITEM.FUNCTION, routinePointer);
    writeField(itemPointer, WORKITEM.CONTEXT, contextPointer);
    writeField(itemPointer, WORKITEM.TYPE,
               (queueType >>> 0) | (isEx ? 0x80000000 : 0));
    writeField(itemPointer, WORKITEM.QUEUED, 1);
    workQueue.push({ itemPointer });
}

function unqueue(itemPointer) {
    const queueIndex = workQueue.findIndex(queuedEntry =>
        queuedEntry.itemPointer === itemPointer);
    if (queueIndex >= 0) workQueue.splice(queueIndex, 1);
    writeField(itemPointer, WORKITEM.QUEUED, 0);
}

// drena a fila a PASSIVE_LEVEL (como as worker threads do NT):
// PIO_WORKITEM_ROUTINE    = void (PDEVICE_OBJECT deviceObject, PVOID context)
// PIO_WORKITEM_ROUTINE_EX = void (PVOID ioObject, PVOID context, PIO_WORKITEM)
// WORKER (ExQueueWorkItem) = void (PVOID context)
function runQueue() {
    while (workQueue.length > 0) {
        const entry = workQueue.shift();
        const itemPointer = entry.itemPointer;
        writeField(itemPointer, WORKITEM.QUEUED, 0);
        const routine = readField(itemPointer, WORKITEM.FUNCTION);
        const deviceObject = readField(itemPointer, WORKITEM.DEVICE_OBJECT);
        const context = readField(itemPointer, WORKITEM.CONTEXT);
        const itemType = readField(itemPointer, WORKITEM.TYPE);
        const jsFunction = jsRoutineByItem.get(itemPointer >>> 0);
        if (jsFunction) {
            jsRoutineByItem.delete(itemPointer >>> 0);
            jsFunction(deviceObject, context);
        }
        else if (itemType & 0x80000000)
            os.execMsAbi(routine, deviceObject, context, itemPointer);
        else if (itemType & 0x40000000)
            os.execMsAbi(routine, context);
        else
            os.execMsAbi(routine, deviceObject, context);
    }
}

// ExInitializeWorkItem(itemPtr, routinePtr, contextPtr): WORK_QUEUE_ITEM do
// modelo Ex (a routine recebe so o context — 1 arg)
function initializeExWorkItem(itemPointer, routinePointer, contextPointer) {
    writeField(itemPointer, WORKITEM.LIST_FLINK, 0);
    writeField(itemPointer, WORKITEM.LIST_BLINK, 0);
    writeField(itemPointer, WORKITEM.FUNCTION, routinePointer);
    writeField(itemPointer, WORKITEM.CONTEXT, contextPointer);
    writeField(itemPointer, WORKITEM.DEVICE_OBJECT, 0);
    writeField(itemPointer, WORKITEM.QUEUED, 0);
}

// ExQueueWorkItem(itemPtr, queueType)
function queueExWorkItem(itemPointer, queueType) {
    if (readField(itemPointer, WORKITEM.QUEUED)) return;
    writeField(itemPointer, WORKITEM.TYPE, (queueType >>> 0) | 0x40000000);
    writeField(itemPointer, WORKITEM.QUEUED, 1);
    workQueue.push({ itemPointer });
}

function pending() { return workQueue.length; }

module.exports = { createWorkItem, queueWorkItem, queueWorkItemEx,
                   queueJsWorkItem, initializeExWorkItem, queueExWorkItem,
                   unqueue, runQueue, pending };
