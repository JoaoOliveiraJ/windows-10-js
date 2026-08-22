// ===========================================================================
// jsOS - system32/ntos/ke/fast-mutex.js: FAST_MUTEX real (wdm.h x64).
//
// Count 1->0 na aquisicao (dono + OldIrql=APC_LEVEL), contencao conta em
// Contention e espera no KEVENT embutido (sinalizado no release). E' o
// mecanismo do NT para travas baratas a IRQL < DISPATCH.
// ===========================================================================

const Irql = require('ntos/ke/irql');
const Dispatcher = require('ntos/ke/dispatcher');
const KernelThreads = require('ntos/ps/kernel-threads');
const NtAbi = require('win32/nt-abi');

const FM = NtAbi.FAST_MUTEX;
const APC_LEVEL = 1;

function readField32(address, fieldOffset) {
    return os.readPhysical32(address + fieldOffset) >>> 0;
}
function writeField32(address, fieldOffset, value) {
    os.writePhysical32(address + fieldOffset, value >>> 0);
}

// ExInitializeFastMutex(fastMutexPtr)
function initialize(fastMutexPointer) {
    writeField32(fastMutexPointer, FM.COUNT, 1);          // livre
    writeField32(fastMutexPointer, FM.OWNER, 0);
    writeField32(fastMutexPointer, FM.OWNER + 4, 0);
    writeField32(fastMutexPointer, FM.CONTENTION, 0);
    writeField32(fastMutexPointer, FM.OLD_IRQL, 0);
    Dispatcher.initializeEvent(fastMutexPointer + FM.EVENT, 0, 0); // sync, reset
}

// ExAcquireFastMutex(fastMutexPtr): sobe p/ APC_LEVEL e toma a posse
function acquire(fastMutexPointer) {
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(APC_LEVEL);
    for (;;) {
        if (readField32(fastMutexPointer, FM.COUNT) === 1) {
            writeField32(fastMutexPointer, FM.COUNT, 0);
            writeField32(fastMutexPointer, FM.OWNER,
                    KernelThreads.getCurrentThreadHandle() || 1);
            writeField32(fastMutexPointer, FM.OLD_IRQL, oldIrql);
            return;
        }
        // contencao real: conta e espera o evento do release
        writeField32(fastMutexPointer, FM.CONTENTION,
                readField32(fastMutexPointer, FM.CONTENTION) + 1);
        Dispatcher.waitForSingleObject(fastMutexPointer + FM.EVENT, 0);
    }
}

// ExTryToAcquireFastMutex(fastMutexPtr) -> 1 se tomou (sem esperar)
function tryAcquire(fastMutexPointer) {
    if (readField32(fastMutexPointer, FM.COUNT) !== 1) return 0;
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(APC_LEVEL);
    writeField32(fastMutexPointer, FM.COUNT, 0);
    writeField32(fastMutexPointer, FM.OWNER,
            KernelThreads.getCurrentThreadHandle() || 1);
    writeField32(fastMutexPointer, FM.OLD_IRQL, oldIrql);
    return 1;
}

// ExReleaseFastMutex(fastMutexPtr): libera, acorda waiters, desce o IRQL
function release(fastMutexPointer) {
    writeField32(fastMutexPointer, FM.OWNER, 0);
    writeField32(fastMutexPointer, FM.COUNT, 1);
    Dispatcher.setEvent(fastMutexPointer + FM.EVENT);   // acorda quem espera
    const oldIrql = readField32(fastMutexPointer, FM.OLD_IRQL);
    Irql.lowerIrql(oldIrql);
}

module.exports = { initialize, acquire, tryAcquire, release };
