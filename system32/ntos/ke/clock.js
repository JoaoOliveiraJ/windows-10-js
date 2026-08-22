// ===========================================================================
// jsOS - system32/ntos/ke/clock.js: relogio de alta resolucao do kernel.
//
// O RTC CMOS (Date.now) so tem resolucao de 1 SEGUNDO — inutil para timers
// de kernel. Aqui o relogio e o TSC (Time Stamp Counter, monotonico por
// hardware), com a frequencia descoberta de verdade:
//   1. CPUID leaf 0x15 (denominador/numerador/crystal clock) quando exposto;
//   2. senao, calibracao contra o PIT i8254: canal 0 em one-shot de ~10ms,
//      OUT observado pelo comando read-back (0xE0) — classico OSDev, sem
//      precisar de IRQs.
// Usado por timers (ke/timer.js), tick count e pelos waits do SMP.
// ===========================================================================

let tscFrequencyHz = 0;      // Hz do TSC
let tscAtBoot = 0;           // TSC no fim da calibracao
let wallClockMsAtBoot = 0;   // Date.now() no mesmo instante (pareamento)

// calibra o TSC contra o PIT: one-shot de 11931 contagens (~10ms a 1.193182MHz)
function calibrateWithPit() {
    const PIT_COUNT = 11931; // ~10ms
    os.writePort8(0x43, 0x30);                    // ch0, lobyte+hibyte, mode 0
    os.writePort8(0x40, PIT_COUNT & 0xFF);
    os.writePort8(0x40, (PIT_COUNT >> 8) & 0xFF);
    const start = os.rdtsc();
    for (;;) {
        os.writePort8(0x43, 0xE0);                // read-back: status do ch0
        if (os.readPort8(0x40) & 0x80) break;     // OUT=1: contagem terminou
    }
    const elapsed = os.rdtsc() - start;
    return elapsed * (1193182 / PIT_COUNT);       // escala p/ 1 segundo
}

function init() {
    // CPUID 0x15: eax=denominador, ebx=numerador, ecx=crystal clock em Hz
    const leaf = os.cpuid(0x15);
    if (leaf[2] && leaf[0] && leaf[1])
        tscFrequencyHz = leaf[2] * (leaf[1] / leaf[0]);
    if (!tscFrequencyHz) {
        os.debugPrint('[clock] CPUID.15 ausente — calibrando TSC via PIT');
        tscFrequencyHz = calibrateWithPit();
    }
    tscAtBoot = os.rdtsc();
    wallClockMsAtBoot = Date.now();
    os.debugPrint('[clock] TSC = ' + (tscFrequencyHz / 1000000).toFixed(1) + ' MHz');
}

// ms desde o boot (resolucao de microssegundos, monotonico)
function uptimeMs() {
    return (os.rdtsc() - tscAtBoot) / tscFrequencyHz * 1000;
}

// relogio de parede em ms (pareado com o RTC no boot + TSC monotonico)
function nowMs() {
    return wallClockMsAtBoot + uptimeMs();
}

// espera ocupada precisa (substitui o waitMs baseado no RTC de 1s)
function spinMs(ms) {
    const deadline = uptimeMs() + ms;
    while (uptimeMs() < deadline) { /* espera proposital */ }
}

module.exports = { init, uptimeMs, nowMs, spinMs,
                   tscFrequencyHz: () => tscFrequencyHz };
