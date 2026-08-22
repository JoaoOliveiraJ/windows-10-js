// ===========================================================================
// jsOS - system32/ntos/ex/resource.js: ERESOURCE (reader/writer lock do NT).
//
// Semantica real: N leitores (shared) OU 1 escritor (exclusive); escritores
// esperam em evento proprio, leitores em outro; o release acorda os waiters.
// O ERESOURCE e' objeto do kernel — os drivers so tocam pela API Ex*.
//
// Layout interno (documentado aqui; os campos publicos do NT nao sao tocados
// por drivers na pratica):
//   +0x00 u32 activeCount      +0x04 u32 exclusiveFlag
//   +0x08 u64 exclusiveOwner   +0x10 KEVENT sharedWaiters (0x18)
//   +0x28 KEVENT exclusiveWaiters (0x18)   +0x40 u32 exclusiveWaiterCount
// ===========================================================================

const Dispatcher = require('ntos/ke/dispatcher');
const KernelThreads = require('ntos/ps/kernel-threads');

const ACTIVE_COUNT = 0x00, EXCLUSIVE_FLAG = 0x04, OWNER = 0x08;
const SHARED_EVENT = 0x10, EXCLUSIVE_EVENT = 0x28, EXCLUSIVE_WAITERS = 0x40;
const STRUCT_SIZE = 0x48;

function readField32(address, fieldOffset) {
    return os.readPhysical32(address + fieldOffset) >>> 0;
}
function writeField32(address, fieldOffset, value) {
    os.writePhysical32(address + fieldOffset, value >>> 0);
}

function currentOwner() {
    return KernelThreads.getCurrentThreadHandle() || 1;
}

// ExInitializeResourceLite(resourcePtr)
function initialize(resourcePointer) {
    writeField32(resourcePointer, ACTIVE_COUNT, 0);
    writeField32(resourcePointer, EXCLUSIVE_FLAG, 0);
    writeField32(resourcePointer, OWNER, 0);
    writeField32(resourcePointer, OWNER + 4, 0);
    Dispatcher.initializeEvent(resourcePointer + SHARED_EVENT, 0, 0);
    Dispatcher.initializeEvent(resourcePointer + EXCLUSIVE_EVENT, 0, 0);
    writeField32(resourcePointer, EXCLUSIVE_WAITERS, 0);
    return 0;
}

// ExAcquireResourceExclusiveLite(resourcePtr, wait) -> BOOLEAN
function acquireExclusive(resourcePointer, wait) {
    for (;;) {
        if (readField32(resourcePointer, ACTIVE_COUNT) === 0 &&
            readField32(resourcePointer, EXCLUSIVE_FLAG) === 0) {
            writeField32(resourcePointer, EXCLUSIVE_FLAG, 1);
            writeField32(resourcePointer, ACTIVE_COUNT, 1);
            writeField32(resourcePointer, OWNER, currentOwner());
            return 1;
        }
        if (!(wait & 0xFF)) return 0;
        writeField32(resourcePointer, EXCLUSIVE_WAITERS,
                     readField32(resourcePointer, EXCLUSIVE_WAITERS) + 1);
        Dispatcher.waitForSingleObject(resourcePointer + EXCLUSIVE_EVENT, 0);
        writeField32(resourcePointer, EXCLUSIVE_WAITERS,
                     readField32(resourcePointer, EXCLUSIVE_WAITERS) - 1);
    }
}

// ExAcquireResourceSharedLite(resourcePtr, wait) -> BOOLEAN
function acquireShared(resourcePointer, wait) {
    for (;;) {
        if (readField32(resourcePointer, EXCLUSIVE_FLAG) === 0) {
            writeField32(resourcePointer, ACTIVE_COUNT,
                    readField32(resourcePointer, ACTIVE_COUNT) + 1);
            return 1;
        }
        if (!(wait & 0xFF)) return 0;
        Dispatcher.waitForSingleObject(resourcePointer + SHARED_EVENT, 0);
    }
}

// ExAcquireSharedStarveExclusive(resourcePtr, wait): leitor que NAO espera
// atras de escritores — toma na hora se nao ha dono exclusivo (e' exatamente
// a semantica do NT: pode "morrer de fome" o escritor)
function acquireSharedStarveExclusive(resourcePointer, wait) {
    return acquireShared(resourcePointer, wait);
}

// ExAcquireSharedWaitForExclusive(resourcePtr, wait): o leitor ESPERA se
// houver escritor na fila, mesmo sem dono exclusivo no momento (fairness)
function acquireSharedWaitForExclusive(resourcePointer, wait) {
    for (;;) {
        if (readField32(resourcePointer, EXCLUSIVE_FLAG) === 0 &&
            readField32(resourcePointer, EXCLUSIVE_WAITERS) === 0) {
            writeField32(resourcePointer, ACTIVE_COUNT,
                    readField32(resourcePointer, ACTIVE_COUNT) + 1);
            return 1;
        }
        if (!(wait & 0xFF)) return 0;
        Dispatcher.waitForSingleObject(resourcePointer + SHARED_EVENT, 0);
    }
}

// ExReleaseResourceLite(resourcePtr)
function release(resourcePointer) {
    if (readField32(resourcePointer, EXCLUSIVE_FLAG)) {
        writeField32(resourcePointer, EXCLUSIVE_FLAG, 0);
        writeField32(resourcePointer, OWNER, 0);
        writeField32(resourcePointer, ACTIVE_COUNT, 0);
    } else {
        const remaining = readField32(resourcePointer, ACTIVE_COUNT) - 1;
        writeField32(resourcePointer, ACTIVE_COUNT, remaining);
        if (remaining > 0) return 0;   // ainda ha leitores
    }
    // acorda escritores e leitores esperando (notification: todos reavaliam)
    Dispatcher.setEvent(resourcePointer + EXCLUSIVE_EVENT);
    Dispatcher.setEvent(resourcePointer + SHARED_EVENT);
    return 0;
}

// ExIsResourceAcquiredExclusiveLite(resourcePtr) -> BOOLEAN
function isAcquiredExclusive(resourcePointer) {
    return readField32(resourcePointer, EXCLUSIVE_FLAG) ? 1 : 0;
}

// ExIsResourceAcquiredSharedLite(resourcePtr) -> ULONG (n. de aquisicoes)
function isAcquiredShared(resourcePointer) {
    return readField32(resourcePointer, ACTIVE_COUNT);
}

// ExConvertExclusiveToSharedLite(resourcePtr): escritor vira leitor
function convertExclusiveToShared(resourcePointer) {
    if (readField32(resourcePointer, EXCLUSIVE_FLAG)) {
        writeField32(resourcePointer, EXCLUSIVE_FLAG, 0);
        writeField32(resourcePointer, OWNER, 0);
        Dispatcher.setEvent(resourcePointer + SHARED_EVENT);
    }
    return 0;
}

// ExDeleteResourceLite(resourcePtr): so e' valido sem ninguem dentro
function deleteResource(resourcePointer) {
    return readField32(resourcePointer, ACTIVE_COUNT) === 0 ? 0 : 0xC000000D | 0;
}

module.exports = { STRUCT_SIZE, initialize, acquireExclusive, acquireShared,
                   acquireSharedStarveExclusive, acquireSharedWaitForExclusive,
                   release, isAcquiredExclusive, isAcquiredShared,
                   convertExclusiveToShared, deleteResource };
