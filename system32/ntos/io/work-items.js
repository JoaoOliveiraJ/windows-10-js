// ===========================================================================
// jsOS - system32/ntos/io/work-items.js: Io Work Items (estilo NT).
//
// IoAllocateWorkItem(device) -> item; IoQueueWorkItem(item, routine, type,
// context) enfileira; o kernel drena a fila a PASSIVE_LEVEL (thread de
// trabalho do sistema). IoFreeWorkItem libera.
//
// WorkItem do convidado (nossa ABI): +0 u64 deviceObjectPtr, +8 u64 routinePtr,
// +16 u64 contextPtr, +24 u64 queuedFlag.
// ===========================================================================

const Irql = require('ntos/ke/irql');

const workQueue = [];   // { itemPointer, devicePointer, routine, context }

function createWorkItem(devicePointer, itemPointer) {
    os.writePhysical32(itemPointer + 0, devicePointer >>> 0);
    os.writePhysical32(itemPointer + 4, 0);
    os.writePhysical32(itemPointer + 8, 0);
    os.writePhysical32(itemPointer + 24, 0);  // queuedFlag = 0
}

function queueWorkItem(itemPointer, routinePointer, _queueType, contextPointer) {
    if (os.readPhysical32(itemPointer + 24)) return;   // ja na fila
    os.writePhysical32(itemPointer + 24, 1);
    workQueue.push({
        itemPointer,
        devicePointer: os.readPhysical32(itemPointer),
        routine: routinePointer,
        context: contextPointer,
    });
}

function unqueue(itemPointer) {
    const i = workQueue.findIndex(e => e.itemPointer === itemPointer);
    if (i >= 0) workQueue.splice(i, 1);
    os.writePhysical32(itemPointer + 24, 0);
}

// drena a fila a PASSIVE_LEVEL (como as worker threads do NT)
function runQueue() {
    while (workQueue.length > 0) {
        const entry = workQueue.shift();
        os.writePhysical32(entry.itemPointer + 24, 0);
        os.execMsAbi(entry.routine, entry.devicePointer, entry.context);
    }
}

function pending() { return workQueue.length; }

module.exports = { createWorkItem, queueWorkItem, unqueue, runQueue, pending };
