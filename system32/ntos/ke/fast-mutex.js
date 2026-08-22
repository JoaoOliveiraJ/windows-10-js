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

function read32(p, o) { return os.readPhysical32(p + o) >>> 0; }
function write32(p, o, v) { os.writePhysical32(p + o, v >>> 0); }

// ExInitializeFastMutex(fastMutexPtr)
function initialize(fastMutexPointer) {
    write32(fastMutexPointer, FM.COUNT, 1);          // livre
    write32(fastMutexPointer, FM.OWNER, 0);
    write32(fastMutexPointer, FM.OWNER + 4, 0);
    write32(fastMutexPointer, FM.CONTENTION, 0);
    write32(fastMutexPointer, FM.OLD_IRQL, 0);
    Dispatcher.initializeEvent(fastMutexPointer + FM.EVENT, 0, 0); // sync, reset
}

// ExAcquireFastMutex(fastMutexPtr): sobe p/ APC_LEVEL e toma a posse
function acquire(fastMutexPointer) {
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(APC_LEVEL);
    for (;;) {
        if (read32(fastMutexPointer, FM.COUNT) === 1) {
            write32(fastMutexPointer, FM.COUNT, 0);
            write32(fastMutexPointer, FM.OWNER,
                    KernelThreads.getCurrentThreadHandle() || 1);
            write32(fastMutexPointer, FM.OLD_IRQL, oldIrql);
            return;
        }
        // contencao real: conta e espera o evento do release
        write32(fastMutexPointer, FM.CONTENTION,
                read32(fastMutexPointer, FM.CONTENTION) + 1);
        Dispatcher.waitForSingleObject(fastMutexPointer + FM.EVENT, 0);
    }
}

// ExTryToAcquireFastMutex(fastMutexPtr) -> 1 se tomou (sem esperar)
function tryAcquire(fastMutexPointer) {
    if (read32(fastMutexPointer, FM.COUNT) !== 1) return 0;
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(APC_LEVEL);
    write32(fastMutexPointer, FM.COUNT, 0);
    write32(fastMutexPointer, FM.OWNER,
            KernelThreads.getCurrentThreadHandle() || 1);
    write32(fastMutexPointer, FM.OLD_IRQL, oldIrql);
    return 1;
}

// ExReleaseFastMutex(fastMutexPtr): libera, acorda waiters, desce o IRQL
function release(fastMutexPointer) {
    write32(fastMutexPointer, FM.OWNER, 0);
    write32(fastMutexPointer, FM.COUNT, 1);
    Dispatcher.setEvent(fastMutexPointer + FM.EVENT);   // acorda quem espera
    const oldIrql = read32(fastMutexPointer, FM.OLD_IRQL);
    Irql.lowerIrql(oldIrql);
}

module.exports = { initialize, acquire, tryAcquire, release };
