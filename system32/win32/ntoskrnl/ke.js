// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ke.js: exports Ke* + DbgPrint com as
// assinaturas REAIS do WDK (ex: KeAcquireSpinLockRaiseToDpc(lock) RETORNA o
// IRQL antigo; Kef* = versoes AtDpcLevel; KeReleaseSpinLock e macro p/
// KfReleaseSpinLock). IRQL em ntos/ke/irql.js, DPCs em ntos/ke/dpc.js.
// ===========================================================================

const Irql = require('ntos/ke/irql');
const KeDpc = require('ntos/ke/dpc');
const KeTimer = require('ntos/ke/timer');
const Dispatcher = require('ntos/ke/dispatcher');
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

// formata uma string printf-style lendo args do convidado:
// %d %i %u %x %X %p %c %% %s (C-string) %S/%wZ (UNICODE_STRING*)
const formatGuestText = GuestStrings.formatGuestText;

// contador de regiao critica (KeEnter/LeaveCriticalRegion)
let criticalRegionCount = 0;

module.exports = {
    names: [
        'DbgPrint',
        'DbgPrintEx',
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
        'KeInitializeEvent',               // (eventPtr, type, initialState)
        'KeSetEvent',                      // (eventPtr, boost, wait) -> anterior
        'KeClearEvent',                    // (eventPtr)
        'KeResetEvent',                    // (eventPtr) -> anterior
        'KeReadStateEvent',                // (eventPtr) -> SignalState
        'KeInitializeMutex',               // (mutexPtr, level)
        'KeReleaseMutex',                  // (mutexPtr, wait)
        'KeWaitForSingleObject',           // (objPtr, reason, mode, alertable, timeoutPtr)
        'KeWaitForMultipleObjects',        // (count, objsPtr, waitType, reason, mode, alertable, timeoutPtr)
        'KeQueryPerformanceCounter',       // (outFreqPtr) -> contador TSC
        'KeStallExecutionProcessor',       // (microseconds) — espera ocupada real
        'KeBugCheckEx',                    // (code, p1..p4) — para o sistema
        'KeSetImportanceDpc',              // (dpcPtr, importance)
        'KeSetTargetProcessorDpc',         // (dpcPtr, processorNumber)
        'KeFlushQueuedDpcs',               // drena a fila de DPCs agora
        'KeEnterCriticalRegion',           // contador de regiao critica real
        'KeLeaveCriticalRegion',
        'KeAreApcsDisabled',
    ],
    handlers: [
        // DbgPrint(formatPtr, args...): printf real do kernel — formata
        // %d/%u/%x/%s/%wZ etc. lendo os args do convidado
        (formatPointer, arg1, arg2, arg3, arg4, arg5, arg6) => {
            const formatText = GuestStrings.readGuestCString(formatPointer);
            const formatted = formatGuestText(formatText,
                [arg1, arg2, arg3, arg4, arg5, arg6]);
            os.debugPrint('[driver] ' + formatted.replace(/\r?\n$/, ''));
            return 0;
        },
        // DbgPrintEx(componentId, level, formatPtr, args...): idem com
        // componente/nivel (o filtro por nivel existe de verdade)
        (componentId, level, formatPointer, arg1, arg2, arg3, arg4, arg5) => {
            const formatText = GuestStrings.readGuestCString(formatPointer);
            const formatted = formatGuestText(formatText,
                [arg1, arg2, arg3, arg4, arg5]);
            os.debugPrint('[driver:' + (componentId >>> 0) + '] ' +
                          formatted.replace(/\r?\n$/, ''));
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
        // KeInitializeEvent(eventPtr, type, initialState)
        (eventPointer, eventType, initialState) => {
            Dispatcher.initializeEvent(eventPointer, eventType >>> 0,
                                       initialState >>> 0);
            return 0;
        },
        // KeSetEvent(eventPtr, boost, wait) -> SignalState anterior
        (eventPointer, _boost, _wait) => Dispatcher.setEvent(eventPointer),
        // KeClearEvent(eventPtr)
        (eventPointer) => { Dispatcher.clearEvent(eventPointer); return 0; },
        // KeResetEvent(eventPtr) -> SignalState anterior
        (eventPointer) => Dispatcher.resetEvent(eventPointer),
        // KeReadStateEvent(eventPtr) -> SignalState
        (eventPointer) => Dispatcher.readState(eventPointer),
        // KeInitializeMutex(mutexPtr, level)
        (mutexPointer, level) => {
            Dispatcher.initializeMutex(mutexPointer, level >>> 0);
            return 0;
        },
        // KeReleaseMutex(mutexPtr, wait)
        (mutexPointer, _wait) => Dispatcher.releaseMutex(mutexPointer),
        // KeWaitForSingleObject(objPtr, reason, mode, alertable, timeoutPtr)
        (objectPointer, _reason, _waitMode, _alertable, timeoutPointer) =>
            Dispatcher.waitForSingleObject(objectPointer, timeoutPointer),
        // KeWaitForMultipleObjects(count, objsPtr, waitType, reason, mode,
        //                          alertable, timeoutPtr)
        (count, objectsPointer, waitType, _reason, _waitMode, _alertable,
         timeoutPointer) =>
            Dispatcher.waitForMultipleObjects(count >>> 0, objectsPointer,
                                              waitType >>> 0, timeoutPointer),
        // KeQueryPerformanceCounter(outFreqPtr) -> contador atual (TSC)
        (frequencyPointer) => {
            if (frequencyPointer) {
                const hz = Math.floor(Clock.tscFrequencyHz());
                GuestMemory.writeGuest32(frequencyPointer, hz >>> 0);
                GuestMemory.writeGuest32(frequencyPointer + 4,
                                         Math.floor(hz / 0x100000000) >>> 0);
            }
            return Math.floor(os.rdtsc());
        },
        // KeStallExecutionProcessor(microseconds): busy-wait medido pelo TSC
        (microseconds) => {
            const ticksToStall = Clock.tscFrequencyHz() / 1000000 *
                                 (microseconds >>> 0);
            const start = os.rdtsc();
            while (os.rdtsc() - start < ticksToStall) { /* stall real */ }
            return 0;
        },
        // KeBugCheckEx(code, p1, p2, p3, p4): parada fatal — como o NT, para
        // a maquina imediatamente (nao retorna)
        (bugCheckCode, param1, param2, param3, param4) => {
            os.debugPrint('');
            os.debugPrint('*** STOP (KeBugCheckEx): 0x' +
                          (bugCheckCode >>> 0).toString(16).padStart(8, '0') +
                          ' (0x' + (param1 >>> 0).toString(16) + ', 0x' +
                          (param2 >>> 0).toString(16) + ', 0x' +
                          (param3 >>> 0).toString(16) + ', 0x' +
                          (param4 >>> 0).toString(16) + ')');
            os.halt();
            return 0;   // nao alcancado
        },
        // KeSetImportanceDpc(dpcPtr, importance): grava na KDPC real
        (dpcPointer, importance) => {
            GuestMemory.writeGuest32(dpcPointer + NtAbi.KDPC.IMPORTANCE,
                                     importance >>> 0);
            return 0;
        },
        // KeSetTargetProcessorDpc(dpcPtr, number): KDPC.Number (campo real)
        (dpcPointer, processorNumber) => {
            GuestMemory.writeGuest32(dpcPointer + 0x08, processorNumber >>> 0);
            GuestMemory.writeGuest32(dpcPointer + 0x0C, 0);
            return 0;
        },
        // KeFlushQueuedDpcs(): drena a fila de DPCs na hora (como o NT)
        () => { KeDpc.runQueue(); return 1; },
        // KeEnterCriticalRegion/KeLeaveCriticalRegion: contador real de
        // regiao critica da "thread" corrente (kernel APCs desabilitados)
        () => { criticalRegionCount++; return 0; },
        () => { if (criticalRegionCount > 0) criticalRegionCount--; return 0; },
        // KeAreApcsDisabled() -> 1 se dentro de regiao critica
        () => criticalRegionCount > 0 ? 1 : 0,
    ],
};
