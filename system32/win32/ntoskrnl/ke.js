// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ke.js: exports Ke* + DbgPrint com as
// assinaturas REAIS do WDK (ex: KeAcquireSpinLockRaiseToDpc(lock) RETORNA o
// IRQL antigo; Kef* = versoes AtDpcLevel; KeReleaseSpinLock e macro p/
// KfReleaseSpinLock). IRQL em ntos/ke/irql.js, DPCs em ntos/ke/dpc.js.
// ===========================================================================

const Irql = require('ntos/ke/irql');
const KeDpc = require('ntos/ke/dpc');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

const bootEpochMs = Date.now();

// spin lock real: test-and-set ate estar livre; retorna o IRQL antigo
function acquireSpinLock(pointer) {
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(Irql.DISPATCH_LEVEL);
    for (;;) {
        if (GuestMemory.readGuest32(pointer) === 0) {
            GuestMemory.writeGuest32(pointer, 1);
            return oldIrql;
        }
    }
}

function releaseSpinLock(pointer, newIrql) {
    GuestMemory.writeGuest32(pointer, 0);
    Irql.lowerIrql(newIrql);
}

module.exports = {
    names: [
        'DbgPrint',
        'KeQuerySystemTime',
        'KeQueryTickCount',
        'KeGetCurrentIrql',
        'KeRaiseIrql',
        'KeLowerIrql',
        'KeInitializeSpinLock',
        'KeAcquireSpinLockRaiseToDpc',     // (lock) -> oldIrql
        'KfAcquireSpinLock',               // idem (fastcall = padrao em x64)
        'KfReleaseSpinLock',               // (lock, newIrql)
        'KefAcquireSpinLockAtDpcLevel',    // (lock) sem subir IRQL
        'KefReleaseSpinLockFromDpcLevel',  // (lock) sem descer IRQL
        'KeInitializeDpc',
        'KeInsertQueueDpc',
        'KeRemoveQueueDpc',
        'KeReleaseSpinLock',               // (lock, newIrql) nome WDK do Kf*
    ],
    handlers: [
        // DbgPrint(formatPtr): texto do convidado -> serial
        (formatPointer) => {
            os.debugPrint('[driver] ' +
                GuestStrings.readGuestCString(formatPointer).replace(/\r?\n$/, ''));
            return 0;
        },
        // KeQuerySystemTime(out u64): intervalos de 100ns desde 1601
        (outputPointer) => {
            const ntTime = (Date.now() + 11644473600000) * 10000;
            GuestMemory.writeGuest32(outputPointer, ntTime % 0x100000000);
            GuestMemory.writeGuest32(outputPointer + 4, Math.floor(ntTime / 0x100000000));
            return 0;
        },
        // KeQueryTickCount(out u64): ms desde o boot
        (outputPointer) => {
            const ticks = Date.now() - bootEpochMs;
            GuestMemory.writeGuest32(outputPointer, ticks % 0x100000000);
            GuestMemory.writeGuest32(outputPointer + 4, Math.floor(ticks / 0x100000000));
            return 0;
        },
        // KeGetCurrentIrql() -> IRQL atual
        () => Irql.getIrql(),
        // KeRaiseIrql(newIrql, outOldPtr)
        (newIrql, outOldPointer) => {
            const oldIrql = Irql.raiseIrql(newIrql);
            if (outOldPointer) GuestMemory.writeGuest32(outOldPointer, oldIrql);
            return 0;
        },
        // KeLowerIrql(newIrql)
        (newIrql) => { Irql.lowerIrql(newIrql); return 0; },
        // KeInitializeSpinLock(ptr)
        (pointer) => { GuestMemory.writeGuest32(pointer, 0); return 0; },
        // KeAcquireSpinLockRaiseToDpc(lock) -> IRQL antigo
        (pointer) => acquireSpinLock(pointer),
        // KfAcquireSpinLock(lock) -> IRQL antigo
        (pointer) => acquireSpinLock(pointer),
        // KfReleaseSpinLock(lock, newIrql)
        (pointer, newIrql) => { releaseSpinLock(pointer, newIrql); return 0; },
        // KefAcquireSpinLockAtDpcLevel(lock): adquire SEM subir IRQL
        (pointer) => {
            for (;;) {
                if (GuestMemory.readGuest32(pointer) === 0) {
                    GuestMemory.writeGuest32(pointer, 1);
                    return 0;
                }
            }
        },
        // KefReleaseSpinLockFromDpcLevel(lock): libera SEM mexer no IRQL
        (pointer) => { GuestMemory.writeGuest32(pointer, 0); return 0; },
        // KeInitializeDpc(dpcPtr, routinePtr, contextPtr)
        (dpcPointer, routinePointer, contextPointer) => {
            KeDpc.initializeDpc(dpcPointer, routinePointer, contextPointer);
            return 0;
        },
        // KeInsertQueueDpc(dpcPtr, sysArg1, sysArg2) -> 1 se enfileirou
        (dpcPointer, sysArg1, sysArg2) =>
            KeDpc.insertQueueDpc(dpcPointer, sysArg1, sysArg2),
        // KeRemoveQueueDpc(dpcPtr) -> 1 se estava na fila
        (dpcPointer) => KeDpc.removeQueueDpc(dpcPointer),
        // KeReleaseSpinLock(lock, newIrql): mesmo handler do KfReleaseSpinLock
        (pointer, newIrql) => { releaseSpinLock(pointer, newIrql); return 0; },
    ],
};
