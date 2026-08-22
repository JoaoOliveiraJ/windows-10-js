// ===========================================================================
// jsOS - system32/ntos/ke/dpc.js: Deferred Procedure Calls (estilo NT).
//
// Drivers registram uma rotina com KeInitializeDpc e enfileiram com
// KeInsertQueueDpc; a fila e drenada pelo kernel ao sair de DISPATCH_LEVEL
// (no nosso idle loop cooperativo, rodando cada DPC a DISPATCH_LEVEL).
//
// KDPC do convidado com o LAYOUT OFICIAL do wdm.h (win32/nt-abi.js):
// DeferredRoutine @0x18, DeferredContext @0x20, SystemArgument1/2 @0x28/0x30
// — a rotina recebe os SystemArguments de verdade, como no NT.
// ===========================================================================

const Irql = require('ntos/ke/irql');
const NtAbi = require('win32/nt-abi');

const KDPC = NtAbi.KDPC;

const dpcQueue = [];   // { dpcPointer } (campos lidos da KDPC real)

function readField(dpcPointer, offset) {
    return os.readPhysical32(dpcPointer + offset) >>> 0;
}
function writeField(dpcPointer, offset, value) {
    os.writePhysical32(dpcPointer + offset, value >>> 0);
}

// KeInitializeDpc(dpc, routine, context): zera e preenche os campos reais
function initializeDpc(dpcPointer, routinePointer, contextPointer) {
    writeField(dpcPointer, KDPC.TYPE, KDPC.TYPE_DPC);
    writeField(dpcPointer, KDPC.IMPORTANCE, KDPC.IMPORTANCE_MEDIUM);
    writeField(dpcPointer, KDPC.DPC_LIST_ENTRY, 0);
    writeField(dpcPointer, KDPC.ROUTINE, routinePointer);
    writeField(dpcPointer, KDPC.ROUTINE + 4, 0);
    writeField(dpcPointer, KDPC.CONTEXT, contextPointer);
    writeField(dpcPointer, KDPC.CONTEXT + 4, 0);
    writeField(dpcPointer, KDPC.SYSARG1, 0);
    writeField(dpcPointer, KDPC.SYSARG2, 0);
    writeField(dpcPointer, KDPC.DPC_DATA, 0);   // nao enfileirado
}

// KeInsertQueueDpc(dpc, sysArg1, sysArg2): grava os SystemArguments na KDPC
// (a rotina vai le-los de la) e enfileira se ainda nao estiver
function insertQueueDpc(dpcPointer, sysArg1, sysArg2) {
    if (readField(dpcPointer, KDPC.DPC_DATA)) return 0;   // ja na fila
    writeField(dpcPointer, KDPC.SYSARG1, sysArg1 >>> 0);
    writeField(dpcPointer, KDPC.SYSARG2, sysArg2 >>> 0);
    writeField(dpcPointer, KDPC.DPC_DATA, 1);
    dpcQueue.push({ dpcPointer });
    return 1;
}

function removeQueueDpc(dpcPointer) {
    const i = dpcQueue.findIndex(e => e.dpcPointer === dpcPointer);
    if (i < 0) return 0;
    dpcQueue.splice(i, 1);
    writeField(dpcPointer, KDPC.DPC_DATA, 0);
    return 1;
}

// drena a fila: cada DPC roda a DISPATCH_LEVEL com (dpc, context, arg1, arg2)
// lidos da KDPC — exatamente a assinatura PKDEFERRED_ROUTINE do WDK
function runQueue() {
    while (dpcQueue.length > 0) {
        const entry = dpcQueue.shift();
        const dpcPointer = entry.dpcPointer;
        writeField(dpcPointer, KDPC.DPC_DATA, 0);
        const routine = readField(dpcPointer, KDPC.ROUTINE);
        const context = readField(dpcPointer, KDPC.CONTEXT);
        const sysArg1 = readField(dpcPointer, KDPC.SYSARG1);
        const sysArg2 = readField(dpcPointer, KDPC.SYSARG2);
        const oldIrql = Irql.getIrql();
        Irql.raiseIrql(Irql.DISPATCH_LEVEL);
        os.execMsAbi(routine, dpcPointer, context, sysArg1, sysArg2);
        Irql.lowerIrql(oldIrql);
    }
}

function pending() { return dpcQueue.length; }

module.exports = { initializeDpc, insertQueueDpc, removeQueueDpc, runQueue, pending };
