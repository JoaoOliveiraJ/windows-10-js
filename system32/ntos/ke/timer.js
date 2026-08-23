// ===========================================================================
// jsOS - system32/ntos/ke/timer.js: KTIMER real (estilo NT).
//
// Drivers usam KeInitializeTimer/KeSetTimer/KeSetTimerEx/KeCancelTimer e
// KeDelayExecutionThread. A fonte de tempo e o RTC do host (Date.now); os
// timers expirados sinalizam o KTIMER (SignalState) e enfileiram o DPC
// associado — exatamente a semantica do NT. A fila e varrida pelo kernel no
// idle loop (runKernelTasks) e durante KeDelayExecutionThread.
//
// DueTime (LARGE_INTEGER, s64 em unidades de 100ns): NEGATIVO = relativo ao
// agora; POSITIVO = absoluto desde 1601. Chega ao JS como double u64
// (ver engine.c) — reconvertido para s64 aqui.
// ===========================================================================

const KeDpc = require('ntos/ke/dpc');
const Clock = require('ntos/ke/clock');
const NtAbi = require('win32/nt-abi');

const KTIMER = NtAbi.KTIMER;
const NT_EPOCH_MS = 11644473600000;   // 1601 -> 1970 em ms
const TWO_POW_63 = 0x8000000000000000;
const TWO_POW_64 = 0x10000000000000000;

// fila de timers ativos: { timerPointer, dueMs, periodMs, dpcPointer }
const activeTimers = [];

function readGuest32(address) { return os.readPhysical32(address) >>> 0; }
function writeGuest32(address, value) { os.writePhysical32(address, value >>> 0); }

function u64ToSigned(value) {
    return value >= TWO_POW_63 ? value - TWO_POW_64 : value;
}

// LARGE_INTEGER s64 (100ns) -> instante absoluto em ms (relógio do kernel)
function dueTimeToMs(signedValue) {
    if (signedValue < 0) return Clock.nowMs() + (-signedValue) / 10000;
    return signedValue / 10000 - NT_EPOCH_MS;
}

function queueIndex(timerPointer) {
    return activeTimers.findIndex(e => e.timerPointer === timerPointer);
}

// KeInitializeTimerEx(timer, type): zera o dispatcher header do KTIMER
function initializeTimer(timerPointer, timerType) {
    writeGuest32(timerPointer + KTIMER.TYPE, timerType);      // Type u8 + flags
    writeGuest32(timerPointer + KTIMER.SIGNAL_STATE, 0);
    writeGuest32(timerPointer + KTIMER.DPC, 0);
    writeGuest32(timerPointer + KTIMER.DPC + 4, 0);
    writeGuest32(timerPointer + KTIMER.PERIOD, 0);
}

// KeSetTimer(timer, dueTime u64, dpc): agenda; retorna se ja estava na fila
function setTimer(timerPointer, dueTimeValue, dpcPointer, periodMs) {
    const wasQueued = queueIndex(timerPointer) >= 0;
    cancelTimer(timerPointer);
    writeGuest32(timerPointer + KTIMER.DPC, dpcPointer >>> 0);
    writeGuest32(timerPointer + KTIMER.PERIOD, periodMs >>> 0);
    activeTimers.push({
        timerPointer,
        dueMs: dueTimeToMs(u64ToSigned(dueTimeValue)),
        periodMs: periodMs >>> 0,
        dpcPointer: dpcPointer >>> 0,
    });
    return wasQueued ? 1 : 0;
}

// KeCancelTimer(timer): tira da fila; retorna se estava agendado
function cancelTimer(timerPointer) {
    const index = queueIndex(timerPointer);
    if (index < 0) return 0;
    activeTimers.splice(index, 1);
    return 1;
}

// varre a fila: expirados -> SignalState=1 + DPC enfileirado (+rearme se
// periodico). Chamado no idle loop e dentro de KeDelayExecutionThread.
function checkTimers() {
    const now = Clock.nowMs();
    for (let i = activeTimers.length - 1; i >= 0; i--) {
        const entry = activeTimers[i];
        if (entry.dueMs > now) continue;
        writeGuest32(entry.timerPointer + KTIMER.SIGNAL_STATE, 1);
        if (entry.dpcPointer)
            KeDpc.insertQueueDpc(entry.dpcPointer, 0, 0);
        if (entry.periodMs > 0) {
            entry.dueMs += entry.periodMs;   // rearme no horario AGENDADO
            if (entry.dueMs <= now) entry.dueMs = now + entry.periodMs; // drift
        } else {
            activeTimers.splice(i, 1);
        }
    }
}

// KeDelayExecutionThread(mode, alertable, intervalPtr): interval e PONTEIRO
// p/ LARGE_INTEGER relativo. Espera de verdade, processando timers/DPCs
// enquanto aguarda (nossas threads sao cooperativas).
function delayExecutionThread(intervalPointer) {
    const raw = readGuest32(intervalPointer) +
                readGuest32(intervalPointer + 4) * 0x100000000;
    const deadline = Clock.nowMs() + (-u64ToSigned(raw)) / 10000;
    for (;;) {
        checkTimers();
        KeDpc.runQueue();
        if (Clock.nowMs() >= deadline) return 0;   // STATUS_SUCCESS
    }
}

function pendingCount() { return activeTimers.length; }

module.exports = { initializeTimer, setTimer, cancelTimer, checkTimers,
                   delayExecutionThread, pendingCount };
