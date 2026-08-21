// ===========================================================================
// jsOS - system32/ntos/ke/dpc.js: Deferred Procedure Calls (estilo NT).
//
// Drivers registram uma rotina com KeInitializeDpc e enfileiram com
// KeInsertQueueDpc; a fila e drenada pelo kernel ao sair de DISPATCH_LEVEL
// (no nosso idle loop cooperativo, rodando cada DPC a DISPATCH_LEVEL).
//
// KDPC do convidado (nossa ABI): +0 u64 routinePtr, +8 u64 contextPtr,
// +16 u64 queuedFlag.
// ===========================================================================

const Irql = require('ntos/ke/irql');

const dpcQueue = [];   // { dpcPointer, routine, context, sysArg1, sysArg2 }

function initializeDpc(dpcPointer, routinePointer, contextPointer) {
    os.writePhysical32(dpcPointer + 0, routinePointer >>> 0);
    os.writePhysical32(dpcPointer + 4, 0);
    os.writePhysical32(dpcPointer + 8, contextPointer >>> 0);
    os.writePhysical32(dpcPointer + 12, 0);
    os.writePhysical32(dpcPointer + 16, 0);   // queuedFlag = 0
}

function insertQueueDpc(dpcPointer, sysArg1, sysArg2) {
    if (os.readPhysical32(dpcPointer + 16)) return 0;   // ja na fila
    os.writePhysical32(dpcPointer + 16, 1);
    dpcQueue.push({
        dpcPointer,
        routine: os.readPhysical32(dpcPointer),
        context: os.readPhysical32(dpcPointer + 8),
        sysArg1, sysArg2,
    });
    return 1;
}

function removeQueueDpc(dpcPointer) {
    const i = dpcQueue.findIndex(e => e.dpcPointer === dpcPointer);
    if (i < 0) return 0;
    dpcQueue.splice(i, 1);
    os.writePhysical32(dpcPointer + 16, 0);
    return 1;
}

// drena a fila: cada DPC roda a DISPATCH_LEVEL, como no NT
function runQueue() {
    while (dpcQueue.length > 0) {
        const entry = dpcQueue.shift();
        os.writePhysical32(entry.dpcPointer + 16, 0);
        const oldIrql = Irql.getIrql();
        Irql.raiseIrql(Irql.DISPATCH_LEVEL);
        os.execMsAbi(entry.routine, entry.dpcPointer, entry.context,
                     entry.sysArg1, entry.sysArg2);
        Irql.lowerIrql(oldIrql);
    }
}

function pending() { return dpcQueue.length; }

module.exports = { initializeDpc, insertQueueDpc, removeQueueDpc, runQueue, pending };
