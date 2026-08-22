// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ke.js: exports Ke* + DbgPrint com as
// assinaturas REAIS do WDK (ex: KeAcquireSpinLockRaiseToDpc(lock) RETORNA o
// IRQL antigo; Kef* = versoes AtDpcLevel; KeReleaseSpinLock e macro p/
// KfReleaseSpinLock). IRQL em ntos/ke/irql.js, DPCs em ntos/ke/dpc.js.
// ===========================================================================

const Irql = require('ntos/ke/irql');
const KeDpc = require('ntos/ke/dpc');
const KeTimer = require('ntos/ke/timer');
const Clock = require('ntos/ke/clock');
const Smp = require('ntos/ke/smp');
const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

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
        'KeGetCurrentProcessorNumber',     // () -> CPU corrente (drivers rodam no BSP)
        'KeQueryActiveProcessorCount',     // () -> CPUs online (SMP real)
        'KeQueryActiveProcessors',         // () -> bitmask KAFFINITY dos online
        'KeGetProcessorNumberFromIndex',   // (index, out PROCESSOR_NUMBER)
        'KeInitializeTimer',               // (ktimerPtr)
        'KeInitializeTimerEx',             // (ktimerPtr, type)
        'KeSetTimer',                      // (ktimerPtr, dueTime u64, dpcPtr)
        'KeSetTimerEx',                    // (ktimerPtr, dueTime u64, period, dpcPtr)
        'KeCancelTimer',                   // (ktimerPtr) -> estava na fila
        'KeReadStateTimer',                // (ktimerPtr) -> SignalState
        'KeDelayExecutionThread',          // (mode, alertable, intervalPtr)
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
        // KeQueryTickCount(out u64): ms desde o boot (TSC de alta resolucao)
        (outputPointer) => {
            const ticks = Math.floor(Clock.uptimeMs());
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
        // KeGetCurrentProcessorNumber(): todo codigo de driver roda no BSP (0)
        () => 0,
        // KeQueryActiveProcessorCount(): CPUs online de verdade (SMP)
        () => Smp.onlineCpuCount(),
        // KeQueryActiveProcessors(): bitmask (bit N = CPU N online)
        () => {
            let mask = 1;   // BSP sempre online
            for (let i = 0; i < Smp.apSlotCount(); i++) mask |= (1 << (i + 1));
            return mask;
        },
        // KeGetProcessorNumberFromIndex(index, out {Group u16, Number u8})
        (processorIndex, outputPointer) => {
            if (processorIndex >= Smp.onlineCpuCount())
                return 0xC000000D | 0;      // STATUS_INVALID_PARAMETER
            if (outputPointer) {
                GuestMemory.writeGuest16(outputPointer, 0);             // Group
                GuestMemory.writeGuest8(outputPointer + 2, processorIndex);
                GuestMemory.writeGuest8(outputPointer + 3, 0);
            }
            return 0;
        },
        // KeInitializeTimer(ktimerPtr): notification timer (como o WDK)
        (timerPointer) => {
            KeTimer.initializeTimer(timerPointer, NtAbi.KTIMER.TIMER_NOTIFICATION);
            return 0;
        },
        // KeInitializeTimerEx(ktimerPtr, type)
        (timerPointer, timerType) => {
            KeTimer.initializeTimer(timerPointer,
                timerType ? NtAbi.KTIMER.TIMER_SYNCHRONIZATION
                          : NtAbi.KTIMER.TIMER_NOTIFICATION);
            return 0;
        },
        // KeSetTimer(ktimerPtr, dueTime u64, dpcPtr)
        (timerPointer, dueTime, dpcPointer) =>
            KeTimer.setTimer(timerPointer, dueTime, dpcPointer, 0),
        // KeSetTimerEx(ktimerPtr, dueTime u64, periodMs, dpcPtr)
        (timerPointer, dueTime, periodMs, dpcPointer) =>
            KeTimer.setTimer(timerPointer, dueTime, dpcPointer, periodMs),
        // KeCancelTimer(ktimerPtr) -> 1 se estava agendado
        (timerPointer) => KeTimer.cancelTimer(timerPointer),
        // KeReadStateTimer(ktimerPtr) -> SignalState
        (timerPointer) =>
            GuestMemory.readGuest32(timerPointer + NtAbi.KTIMER.SIGNAL_STATE),
        // KeDelayExecutionThread(mode, alertable, intervalPtr)
        (_waitMode, _alertable, intervalPointer) =>
            KeTimer.delayExecutionThread(intervalPointer),
    ],
};
