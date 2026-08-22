// ===========================================================================
// jsOS - system32/ntos/ke/dispatcher.js: objetos do dispatcher NT (KEVENT e
// KMUTEX) com KeWaitForSingleObject/MultipleObjects de verdade.
//
// Semantica real:
//  - NotificationEvent: sinaliza e fica sinalizado (acorda TODOS; nao consome)
//  - SynchronizationEvent: ao acordar um waiter, o evento RESSETA (auto-reset)
//  - KMUTEX: SignalState 1 = livre; adquirir zera e marca o dono
// KeWaitFor* bloqueia de verdade: como nossas threads sao cooperativas, o
// wait bombeia o kernel (timers/DPCs/work items) ate sinalizar ou estourar o
// timeout (Timeout: NULL = infinito; 0 = so testa; negativo = relativo 100ns).
// ===========================================================================

const KeDpc = require('ntos/ke/dpc');
const KeTimer = require('ntos/ke/timer');
const Clock = require('ntos/ke/clock');
const KernelThreads = require('ntos/ps/kernel-threads');
const WorkItems = require('ntos/io/work-items');
const NtAbi = require('win32/nt-abi');

const HEADER = NtAbi.DISPATCHER_HEADER;
const TWO_POW_63 = 0x8000000000000000;
const TWO_POW_64 = 0x10000000000000000;

const STATUS_SUCCESS = 0;
const STATUS_TIMEOUT = 0x102;

function readGuest32(address) { return os.readPhysical32(address) >>> 0; }
function writeGuest32(address, value) { os.writePhysical32(address, value >>> 0); }
function readGuest8(address) { return os.readPhysical8(address); }
function writeGuest8(address, value) { os.writePhysical8(address, value & 0xFF); }

// ---- eventos ---------------------------------------------------------------
function initializeEvent(eventPointer, eventType, initialState) {
    writeGuest8(eventPointer + HEADER.TYPE, eventType);
    writeGuest32(eventPointer + HEADER.SIGNAL_STATE, initialState ? 1 : 0);
}
function setEvent(eventPointer) {
    const previous = readGuest32(eventPointer + HEADER.SIGNAL_STATE);
    writeGuest32(eventPointer + HEADER.SIGNAL_STATE, 1);
    return previous;
}
function clearEvent(eventPointer) {
    writeGuest32(eventPointer + HEADER.SIGNAL_STATE, 0);
}
function resetEvent(eventPointer) {
    const previous = readGuest32(eventPointer + HEADER.SIGNAL_STATE);
    writeGuest32(eventPointer + HEADER.SIGNAL_STATE, 0);
    return previous;
}
function readState(objectPointer) {
    return readGuest32(objectPointer + HEADER.SIGNAL_STATE);
}

// ---- mutex ------------------------------------------------------------------
function initializeMutex(mutexPointer, _level) {
    writeGuest8(mutexPointer + HEADER.TYPE, HEADER.TYPE_MUTANT);
    writeGuest32(mutexPointer + HEADER.SIGNAL_STATE, 1);       // 1 = livre
    writeGuest32(mutexPointer + HEADER.MUTEX_OWNER, 0);
    writeGuest32(mutexPointer + HEADER.MUTEX_OWNER + 4, 0);
}
function releaseMutex(mutexPointer) {
    const previous = readGuest32(mutexPointer + HEADER.SIGNAL_STATE);
    writeGuest32(mutexPointer + HEADER.MUTEX_OWNER, 0);
    writeGuest32(mutexPointer + HEADER.MUTEX_OWNER + 4, 0);
    writeGuest32(mutexPointer + HEADER.SIGNAL_STATE, 1);
    return previous ? 0 : 1;   // BOOLEAN: nao estava sinalizado
}

// ---- aquisicao --------------------------------------------------------------
// tenta adquirir/satisfazer o objeto; retorna true se o wait pode prosseguir
function tryAcquire(objectPointer) {
    const objectType = readGuest8(objectPointer + HEADER.TYPE);
    const signaled = readGuest32(objectPointer + HEADER.SIGNAL_STATE);
    switch (objectType) {
    case HEADER.TYPE_EVENT_NOTIFICATION:
        return signaled !== 0;                       // nao consome
    case HEADER.TYPE_EVENT_SYNCHRONIZATION:
        if (!signaled) return false;
        writeGuest32(objectPointer + HEADER.SIGNAL_STATE, 0);  // auto-reset
        return true;
    case HEADER.TYPE_MUTANT:
        if (!signaled) return false;
        writeGuest32(objectPointer + HEADER.SIGNAL_STATE, 0);
        const owner = KernelThreads.getCurrentThreadHandle() || 1;
        writeGuest32(objectPointer + HEADER.MUTEX_OWNER, owner >>> 0);
        return true;
    default:
        return false;
    }
}

// timeout: ponteiro p/ LARGE_INTEGER (null = infinito) -> ms ou null/0
function timeoutPointerToMs(timeoutPointer) {
    if (!timeoutPointer) return null;
    const raw = readGuest32(timeoutPointer) +
                readGuest32(timeoutPointer + 4) * 0x100000000;
    if (raw === 0) return 0;                          // so testa
    const signed = raw >= TWO_POW_63 ? raw - TWO_POW_64 : raw;
    return (-signed) / 10000;                         // relativo em ms
}

function pumpKernel() {
    KeTimer.checkTimers();
    KeDpc.runQueue();
    WorkItems.runQueue();
}

// KeWaitForSingleObject(object, reason, mode, alertable, timeoutPtr)
function waitForSingleObject(objectPointer, timeoutPointer) {
    const timeoutMs = timeoutPointerToMs(timeoutPointer);
    const deadline = timeoutMs === null ? null : Clock.uptimeMs() + timeoutMs;
    for (;;) {
        if (tryAcquire(objectPointer)) return STATUS_SUCCESS;
        if (timeoutMs === 0) return STATUS_TIMEOUT;
        if (deadline !== null && Clock.uptimeMs() >= deadline) return STATUS_TIMEOUT;
        pumpKernel();
    }
}

// KeWaitForMultipleObjects(count, objectsPtr, waitType, reason, mode,
//                          alertable, timeoutPtr, waitBlockArray)
// waitType: 0 = WaitAll, 1 = WaitAny. Retorna o indice (WaitAny) ou SUCCESS.
function waitForMultipleObjects(count, objectsArrayPointer, waitType, timeoutPointer) {
    const objects = [];
    for (let i = 0; i < count; i++)
        objects.push(readGuest32(objectsArrayPointer + i * 8));   // ponteiros u64
    const timeoutMs = timeoutPointerToMs(timeoutPointer);
    const deadline = timeoutMs === null ? null : Clock.uptimeMs() + timeoutMs;
    for (;;) {
        if (waitType === 1) {                        // WaitAny
            for (let i = 0; i < objects.length; i++)
                if (tryAcquire(objects[i])) return i;
        } else {                                     // WaitAll
            if (objects.every(o => readState(o) !== 0)) {
                for (const o of objects) tryAcquire(o);
                return STATUS_SUCCESS;
            }
        }
        if (timeoutMs === 0) return STATUS_TIMEOUT;
        if (deadline !== null && Clock.uptimeMs() >= deadline) return STATUS_TIMEOUT;
        pumpKernel();
    }
}

module.exports = { initializeEvent, setEvent, clearEvent, resetEvent,
                   readState, initializeMutex, releaseMutex,
                   waitForSingleObject, waitForMultipleObjects };
