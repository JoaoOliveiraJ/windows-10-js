// ===========================================================================
// jsOS - system32/ntos/io/io-timer.js: IoInitializeTimer/IoStartTimer/
// IoStopTimer (estilo NT): uma rotina por device, chamada a cada ~1 segundo
// enquanto o timer estiver ligado. O DEVICE_OBJECT.Timer (@0x28) marca o
// device com timer inicializado, como no NT.
// ===========================================================================

const Clock = require('ntos/ke/clock');
const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');

const IO_TIMER_PERIOD_MS = 1000;   // periodo do IoTimer no NT

// { devicePointer, routinePointer, contextPointer, active, nextDueMs }
const deviceTimers = [];

function findTimer(devicePointer) {
    return deviceTimers.find(t => t.devicePointer === devicePointer);
}

// IoInitializeTimer(devicePtr, routinePtr, contextPtr): DEVICE_OBJECT.Timer=1
function initializeTimer(devicePointer, routinePointer, contextPointer) {
    if (findTimer(devicePointer)) return 0xC0000035 | 0;  // STATUS_OBJECT_NAME_COLLISION-ish
    deviceTimers.push({
        devicePointer,
        routinePointer: routinePointer >>> 0,
        contextPointer: contextPointer >>> 0,
        active: false,
        nextDueMs: 0,
    });
    GuestMemory.writeGuest64(devicePointer + NtAbi.DEVICE_OBJECT.TIMER, 1);
    return 0;
}

function startTimer(devicePointer) {
    const timer = findTimer(devicePointer);
    if (!timer) return 0xC000000D | 0;   // STATUS_INVALID_PARAMETER
    timer.active = true;
    timer.nextDueMs = Clock.uptimeMs() + IO_TIMER_PERIOD_MS;
    return 0;
}

function stopTimer(devicePointer) {
    const timer = findTimer(devicePointer);
    if (!timer) return 0xC000000D | 0;
    timer.active = false;
    return 0;
}

// chamado no idle loop (runKernelTasks): dispara os timers vencidos
function checkIoTimers() {
    const now = Clock.uptimeMs();
    for (const timer of deviceTimers) {
        if (!timer.active || timer.nextDueMs > now) continue;
        timer.nextDueMs = now + IO_TIMER_PERIOD_MS;
        // IoTimerRoutine(deviceObject, context) — ABI MS, 2 args
        os.execMsAbi(timer.routinePointer, timer.devicePointer,
                     timer.contextPointer);
    }
}

function forgetDevice(devicePointer) {
    const index = deviceTimers.findIndex(t => t.devicePointer === devicePointer);
    if (index >= 0) deviceTimers.splice(index, 1);
}

module.exports = { initializeTimer, startTimer, stopTimer, checkIoTimers,
                   forgetDevice };
