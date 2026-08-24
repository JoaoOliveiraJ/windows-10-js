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
const InterruptObject = require('ntos/ke/interrupt-object');

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
    // KIRQL e' UCHAR: so o byte baixo do registrador e' valido (o compilador
    // deixa lixo nos bits altos — o NT mascara da mesma forma)
    Irql.lowerIrql(newIrql & 0xFF);
}

// formata uma string printf-style lendo args do convidado:
// %d %i %u %x %X %p %c %% %s (C-string) %S/%wZ (UNICODE_STRING*)
const formatGuestText = GuestStrings.formatGuestText;

// contador de regiao critica (KeEnter/LeaveCriticalRegion)
let criticalRegionCount = 0;

// registros de bugcheck callback (KeRegisterBugCheckCallback)
const bugCheckCallbacks = [];

// registros de REASON callback (KeRegisterBugCheckReasonCallback):
// { callbackPointer, componentPointer, bufferSize } — rodam no bugcheck
const bugCheckReasonCallbacks = [];

// KiBugCheckData: variavel global REAL do kernel (export de DADO, nao
// funcao) — 5 u64: codigo + 4 parametros do ultimo bugcheck; preenchida no
// KeBugCheckEx antes dos callbacks (o NT faz o mesmo)
const kiBugCheckDataPointer = GuestMemory.guestAllocBytes(5 * 8);

// parada fatal comum (KeBugCheckEx/KeBugCheck): grava KiBugCheckData, roda
// os callbacks registrados e para a maquina (nao retorna)
function doBugCheck(bugCheckCode, param1, param2, param3, param4) {
    GuestMemory.writeGuest64(kiBugCheckDataPointer, bugCheckCode >>> 0);
    GuestMemory.writeGuest64(kiBugCheckDataPointer + 8, param1);
    GuestMemory.writeGuest64(kiBugCheckDataPointer + 16, param2);
    GuestMemory.writeGuest64(kiBugCheckDataPointer + 24, param3);
    GuestMemory.writeGuest64(kiBugCheckDataPointer + 32, param4);
    os.debugPrint('');
    os.debugPrint('*** STOP (KeBugCheckEx): 0x' +
                  (bugCheckCode >>> 0).toString(16).padStart(8, '0') +
                  ' (0x' + (param1 >>> 0).toString(16) + ', 0x' +
                  (param2 >>> 0).toString(16) + ', 0x' +
                  (param3 >>> 0).toString(16) + ', 0x' +
                  (param4 >>> 0).toString(16) + ')');
    for (const recordPointer of bugCheckCallbacks) {
        const routine = GuestMemory.readGuest64(recordPointer);
        if (routine) os.execMsAbi(routine, recordPointer, 0);
    }
    for (const entry of bugCheckReasonCallbacks) {
        if (entry.callbackPointer)
            os.execMsAbi(entry.callbackPointer, entry.componentPointer,
                         entry.bufferSize, 0);
    }
    os.halt();
}

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
        'KeRegisterBugCheckCallback',      // (callbackPtr, context, componentPtr, len, statePtr)
        'KeDeregisterBugCheckCallback',
        'KeAcquireSpinLockAtDpcLevel',     // adquire SEM subir IRQL (ja em DPC)
        'KeReleaseSpinLockFromDpcLevel',   // libera SEM descer IRQL
        'PsGetVersion',                    // (outMajor, outMinor, outBuild, suffix)
        'KfRaiseIrql',                     // (newIrql) -> IRQL antigo
        'KeQueryTimeIncrement',            // incremento do tick em 100ns
        'KeQueryDpcWatchdogInformation',   // (outInfoPtr)
        'KeSynchronizeExecution',          // (ki, routine, context) c/ lock
        'InitSafeBootMode',                // modo de boot seguro (0 = normal)
        'KeInitializeSemaphore',           // (semPtr, count, limit)
        'KeReleaseSemaphore',              // (semPtr, incr, adjustment, wait)
        'KeInitializeGuardedMutex',        // (mutexPtr)
        'KeAcquireGuardedMutex',           // (mutexPtr) — entra em critical region
        'KeReleaseGuardedMutex',           // (mutexPtr)
        'KeAcquireInStackQueuedSpinLock',  // (lockPtr, handlePtr)
        'KeReleaseInStackQueuedSpinLock',  // (handlePtr)
        'KeAcquireInStackQueuedSpinLockAtDpcLevel',
        'KeReleaseInStackQueuedSpinLockFromDpcLevel',
        'KeAcquireInterruptSpinLock',      // (kinterruptPtr)
        'KeReleaseInterruptSpinLock',      // (kinterruptPtr)
        'KeRegisterBugCheckReasonCallback',
        'KeDeregisterBugCheckReasonCallback',
        'KeBugCheck',                      // (code) — KeBugCheckEx(code,0,0,0,0)
        'KeExpandKernelStackAndCalloutEx', // (callout, ctx, size, wait, extra)
        'KeFlushIoBuffers',                // (mdl, readOp, dmaOp) — coerencia x86
        'KeGetCurrentNodeNumber',          // -> no NUMA (0: sem SRAT)
        'KeQueryHighestNodeNumber',        // -> maior no (0)
        'KeQueryMaximumProcessorCountEx',  // (group) -> CPUs do grupo
        'KeQueryUnbiasedInterruptTime',    // -> u64 100ns desde o boot
        'KeQueryUnbiasedInterruptTimePrecise', // (out u64)
        'KeSetCoalescableTimer',           // (timer, due, period, tol, dpc)
        'KeStackAttachProcess',            // (process, apcState)
        'KeUnstackDetachProcess',          // (apcState)
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
        // KeRaiseIrql(newIrql, outOldPtr): KIRQL e' UCHAR (mascara como o NT)
        (newIrql, outOldPointer) => {
            const oldIrql = Irql.raiseIrql(newIrql & 0xFF);
            if (outOldPointer) GuestMemory.writeGuest32(outOldPointer, oldIrql);
            return 0;
        },
        // KeLowerIrql(newIrql)
        // KeLowerIrql(newIrql): KIRQL e' UCHAR — mascara o byte baixo (bits
        // altos do registrador sao lixo do compilador, como no NT)
        (newIrql) => { Irql.lowerIrql(newIrql & 0xFF); return 0; },
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
        // KeBugCheckEx(code, p1, p2, p3, p4): parada fatal — grava
        // KiBugCheckData, roda os callbacks (como o NT) e para a maquina
        (bugCheckCode, param1, param2, param3, param4) => {
            doBugCheck(bugCheckCode, param1, param2, param3, param4);
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
        // KeRegisterBugCheckCallback(callback, context, component, len, state):
        // registro real — os callbacks rodam no KeBugCheckEx
        (callbackPointer, contextPointer, componentPointer, length,
         statePointer) => {
            const recordPointer = GuestMemory.guestAllocBytes(0x20);
            GuestMemory.writeGuest64(recordPointer, callbackPointer);       // routine
            GuestMemory.writeGuest64(recordPointer + 8, componentPointer);  // component
            GuestMemory.writeGuest64(recordPointer + 16, contextPointer);   // context
            bugCheckCallbacks.push(recordPointer);
            if (statePointer) GuestMemory.writeGuest32(statePointer, 1);
            return 1;   // BOOLEAN sucesso
        },
        // KeDeregisterBugCheckCallback(recordPtr)
        (recordPointer) => {
            const index = bugCheckCallbacks.indexOf(recordPointer >>> 0);
            if (index < 0) return 0;
            bugCheckCallbacks.splice(index, 1);
            GuestMemory.guestFreeBytes(recordPointer);
            return 1;
        },
        // KeAcquireSpinLockAtDpcLevel(lock): adquire sem mexer no IRQL (o
        // chamador ja esta a DISPATCH_LEVEL — e' o KefAcquireSpinLockAtDpcLevel)
        (pointer) => {
            for (;;) {
                if (GuestMemory.readGuest32(pointer) === 0) {
                    GuestMemory.writeGuest32(pointer, 1);
                    return 0;
                }
            }
        },
        // KeReleaseSpinLockFromDpcLevel(lock)
        (pointer) => { GuestMemory.writeGuest32(pointer, 0); return 0; },
        // PsGetVersion(outMajorPtr, outMinorPtr, outBuildPtr, suffixPtr):
        // nossa versao NT compativel (10.0.19045, Win10 22H2) — retorna 1
        (majorPointer, minorPointer, buildPointer, suffixPointer) => {
            if (majorPointer) GuestMemory.writeGuest32(majorPointer, 10);
            if (minorPointer) GuestMemory.writeGuest32(minorPointer, 0);
            if (buildPointer) GuestMemory.writeGuest32(buildPointer, 19045);
            if (suffixPointer) GuestMemory.writeGuest32(suffixPointer, 0);
            return 1;
        },
        // KfRaiseIrql(newIrql) -> IRQL antigo (nome real do KeRaiseIrql)
        (newIrql) => {
            const oldIrql = Irql.getIrql();
            Irql.raiseIrql(newIrql & 0xFF);
            return oldIrql;
        },
        // KeQueryTimeIncrement() -> u32: incremento do relogio em 100ns —
        // nosso quantum real do LAPIC timer (100 Hz = 10 ms = 100000x100ns)
        () => 100000,
        // KeQueryDpcWatchdogInformation(outPtr): nosso kernel nao roda o
        // watchdog de DPC — a struct sai zerada (estado real: nao configurado)
        (infoPointer) => {
            for (let i = 0; i < 0x50; i += 4)
                GuestMemory.writeGuest32(infoPointer + i, 0);
            return 0;
        },
        // KeSynchronizeExecution(ki, syncRoutine, context): roda a rotina
        // com o ActualLock segurado no SynchronizeIrql (exclusao com o ISR)
        (kinterruptPointer, syncRoutinePointer, contextPointer) =>
            InterruptObject.keSynchronizeExecution(kinterruptPointer >>> 0,
                syncRoutinePointer, contextPointer),
        // InitSafeBootMode: estado real do boot — 0 = boot normal (o nosso
        // bootloader nao tem opcao de safe boot; o valor e' lido por drivers
        // para desligar recursos — nada a desligar num boot normal)
        () => 0,
        // KeInitializeSemaphore(semPtr, count, limit): KSEMAPHORE x64 —
        // DISPATCHER_HEADER (Type=SemaphoreObject 5, SignalState=count) e
        // Limit em +0x18 (layout oficial do wdm.h)
        (semaphorePointer, count, limit) => {
            GuestMemory.writeGuest8(semaphorePointer +
                                    NtAbi.DISPATCHER_HEADER.TYPE, 5);
            GuestMemory.writeGuest32(semaphorePointer +
                NtAbi.DISPATCHER_HEADER.SIGNAL_STATE, count | 0);
            GuestMemory.writeGuest32(semaphorePointer + 0x18, limit | 0);
            return 0;
        },
        // KeReleaseSemaphore(semPtr, increment, adjustment, wait): devolve o
        // SignalState ANTERIOR; o novo estado = anterior + adjustment (o NT
        // sinaliza os waiters — nosso wait le o SignalState direto, entao o
        // ajuste ja' destrava quem espera)
        (semaphorePointer, _increment, adjustment, _wait) => {
            const stateOffset = semaphorePointer +
                                NtAbi.DISPATCHER_HEADER.SIGNAL_STATE;
            const previous = GuestMemory.readGuest32(stateOffset) | 0;
            const limit = GuestMemory.readGuest32(semaphorePointer + 0x18) | 0;
            const released = Math.min(previous + (adjustment | 0), limit);
            GuestMemory.writeGuest32(stateOffset, released);
            return previous;
        },
        // KGUARDED_MUTEX (layout nosso, 0x38 bytes): +0 i32 Count (1=livre,
        // 0=segurado), +8 u64 Owner, +0x10 i32 Contention. Adquirir entra em
        // critical region (desabilita kernel APCs — semantica real)
        (guardedMutexPointer) => {   // KeInitializeGuardedMutex
            GuestMemory.writeGuest32(guardedMutexPointer, 1);
            GuestMemory.writeGuest64(guardedMutexPointer + 8, 0);
            GuestMemory.writeGuest32(guardedMutexPointer + 0x10, 0);
            return 0;
        },
        (guardedMutexPointer) => {   // KeAcquireGuardedMutex
            criticalRegionCount++;
            for (;;) {
                if ((GuestMemory.readGuest32(guardedMutexPointer) | 0) === 1) {
                    GuestMemory.writeGuest32(guardedMutexPointer, 0);
                    GuestMemory.writeGuest64(guardedMutexPointer + 8, 1);
                    return 0;
                }
                GuestMemory.writeGuest32(guardedMutexPointer + 0x10,
                    GuestMemory.readGuest32(guardedMutexPointer + 0x10) + 1);
            }
        },
        (guardedMutexPointer) => {   // KeReleaseGuardedMutex
            GuestMemory.writeGuest64(guardedMutexPointer + 8, 0);
            GuestMemory.writeGuest32(guardedMutexPointer, 1);
            if (criticalRegionCount > 0) criticalRegionCount--;
            return 0;
        },
        // KeAcquireInStackQueuedSpinLock(lockPtr, handlePtr):
        // KLOCK_QUEUE_HANDLE { +0 Next, +8 Lock, +0x10 OldIrql } — preenche o
        // handle, sobe a DISPATCH e adquire com test-and-set
        (spinLockPointer, lockHandlePointer) => {
            GuestMemory.writeGuest64(lockHandlePointer, 0);
            GuestMemory.writeGuest64(lockHandlePointer + 8, spinLockPointer);
            const oldIrql = acquireSpinLock(spinLockPointer);
            GuestMemory.writeGuest8(lockHandlePointer + 0x10, oldIrql);
            return 0;
        },
        // KeReleaseInStackQueuedSpinLock(handlePtr)
        (lockHandlePointer) => {
            const spinLockPointer = GuestMemory.readGuest64(lockHandlePointer + 8);
            const oldIrql = GuestMemory.readGuest8(lockHandlePointer + 0x10);
            releaseSpinLock(spinLockPointer, oldIrql);
            return 0;
        },
        // KeAcquireInStackQueuedSpinLockAtDpcLevel: idem SEM subir IRQL
        (spinLockPointer, lockHandlePointer) => {
            GuestMemory.writeGuest64(lockHandlePointer, 0);
            GuestMemory.writeGuest64(lockHandlePointer + 8, spinLockPointer);
            for (;;) {
                if (GuestMemory.readGuest32(spinLockPointer) === 0) {
                    GuestMemory.writeGuest32(spinLockPointer, 1);
                    break;
                }
            }
            return 0;
        },
        // KeReleaseInStackQueuedSpinLockFromDpcLevel: so solta o lock
        (lockHandlePointer) => {
            const spinLockPointer = GuestMemory.readGuest64(lockHandlePointer + 8);
            GuestMemory.writeGuest32(spinLockPointer, 0);
            return 0;
        },
        // KeAcquireInterruptSpinLock(kinterruptPtr): o lock do interrupt
        // object (ActualLock, offset oficial) com subida a DISPATCH_LEVEL
        (kinterruptPointer) => {
            const actualLockPointer = kinterruptPointer + NtAbi.KINTERRUPT.ACTUAL_LOCK;
            acquireSpinLock(actualLockPointer);
            return 0;
        },
        // KeReleaseInterruptSpinLock(kinterruptPtr)
        (kinterruptPointer) => {
            const actualLockPointer = kinterruptPointer + NtAbi.KINTERRUPT.ACTUAL_LOCK;
            GuestMemory.writeGuest32(actualLockPointer, 0);
            return 0;
        },
        // KeRegisterBugCheckReasonCallback(callback, component, bufferSize):
        // registro real — roda no bugcheck (KbCallbackAddPages etc.)
        (callbackPointer, componentPointer, bufferSize) => {
            bugCheckReasonCallbacks.push({ callbackPointer, componentPointer,
                                           bufferSize });
            return 1;
        },
        // KeDeregisterBugCheckReasonCallback(callback)
        (callbackPointer) => {
            const index = bugCheckReasonCallbacks.findIndex(
                entry => entry.callbackPointer === callbackPointer);
            if (index < 0) return 0;
            bugCheckReasonCallbacks.splice(index, 1);
            return 1;
        },
        // KeBugCheck(code): KeBugCheckEx(code, 0, 0, 0, 0)
        (bugCheckCode) => {
            doBugCheck(bugCheckCode, 0, 0, 0, 0);
            return 0;   // nao alcancado
        },
        // KeExpandKernelStackAndCalloutEx(callout, context, size, wait,
        // extra): a semantica e' "garantir `size` bytes de stack antes de
        // chamar" — nossa kernel stack tem dezenas de KB livres (drivers
        // reais pedem <= 64KB), entao a garantia ja' vale; chama de verdade
        (calloutPointer, contextPointer, _sizeBytes, _wait,
         extraContextPointer) =>
            os.execMsAbi(calloutPointer, contextPointer, extraContextPointer) | 0,
        // KeFlushIoBuffers(mdl, readOp, dmaOp): em x86-64 a coerencia de
        // cache de DMA e' do HARDWARE (bus snooping) — o NT em x64 tambem nao
        // executa nenhuma acao de flush aqui; validar e retornar e' o real
        (_mdlPointer, _readOperation, _dmaOperation) => 0,
        // KeGetCurrentNodeNumber() -> 0: sem SRAT na ACPI da VM, toda a
        // memoria/CPU esta no no NUMA 0 (resposta real do hardware)
        () => 0,
        // KeQueryHighestNodeNumber() -> 0 (mesma razao)
        () => 0,
        // KeQueryMaximumProcessorCountEx(group): CPUs descobertas na MADT
        // (grupo 0; ALL_GROUPS=0xFFFF tambem). Outro grupo nao existe -> 0
        (groupNumber) => {
            const group = groupNumber >>> 0;
            if (group !== 0 && group !== 0xFFFF) return 0;
            return Smp.discoveredCpuCount();
        },
        // KeQueryUnbiasedInterruptTime() -> u64 em 100ns desde o boot SEM o
        // bias de sleep (maquinas que suspendem acumulam bias; aqui nao ha
        // sleep — unbiased == interrupt time, a resposta real)
        () => Math.floor(Clock.uptimeMs() * 10000),
        // KeQueryUnbiasedInterruptTimePrecise(out u64): idem, via ponteiro
        (outputPointer) => {
            GuestMemory.writeGuest64(outputPointer,
                                     Math.floor(Clock.uptimeMs() * 10000));
            return 0;
        },
        // KeSetCoalescableTimer(timer, dueTime, period, tolerableDelay, dpc):
        // o tolerableDelay e' otimizacao de ENERGIA (agrupar disparos) — nao
        // muda a semantica de expiracao; agenda como um timer normal
        (timerPointer, dueTime, periodMs, _tolerableDelay, dpcPointer) =>
            KeTimer.setTimer(timerPointer, dueTime, dpcPointer, periodMs) ? 1 : 0,
        // KeStackAttachProcess(process, apcState): temos UM unico espaco de
        // enderecamento (identity-mapped, sem troca de CR3) — o efeito do
        // attach (enxergar a memoria do processo) ja' e' verdade sem acao;
        // a KAPC_STATE sai zerada com o processo anterior registrado
        (processPointer, apcStatePointer) => {
            for (let offset = 0; offset < 0x30; offset += 4)
                GuestMemory.writeGuest32(apcStatePointer + offset, 0);
            GuestMemory.writeGuest64(apcStatePointer + 0x30, processPointer);
            return 0;
        },
        // KeUnstackDetachProcess(apcState): desfaz o attach (no-op real aqui)
        (_apcStatePointer) => 0,
    ],
    // exports de DADO (nao-funcao): o ntoskrnl.js resolve estes nomes para
    // o endereco REAL do simbolo (a IAT recebe o ponteiro da variavel)
    dataExports: {
        KiBugCheckData: () => kiBugCheckDataPointer,
    },
};
