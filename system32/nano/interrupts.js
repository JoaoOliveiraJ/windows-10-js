// ===========================================================================
// jsOS - system32/nano/irq.js: gerente de interrupcoes do nanokernel.
//
// 100% JS: constroi a IDT na memoria fisica (0x82000), programa o PIC 8259
// e o PIT (100 Hz) pelas portas, e carrega a tabela com os.loadIdt().
// Os trampolins asm (hal/core/irqstubs.asm) so registram o evento em memoria
// compartilhada + ring do teclado + EOI; a LEITURA e a politica sao daqui.
//
// DISPATCH REAL: cada vetor tem um handler JS registrado; dispatchPending()
// (chamado no idle loop e ao baixar IRQL) compara os contadores do hardware
// e chama os handlers — o modelo ISR(conta)->DPC(despacha) do NT.
//
// Memoria compartilhada (ver irqstubs.asm):
//   0x81000: contagem por vetor (u32 cada)   0x81100: ring buffer do teclado
// ===========================================================================

const Clock = require('ntos/ke/clock');

const IDT_ADDR  = 0x82000;
const STUB_SIZE = 10;
const IRQ_COUNT = 0x81000;
const KBD_HEAD  = 0x81400, KBD_TAIL = 0x81404, KBD_DATA = 0x81408;

const CODE64_SEL = 0x18;   // seletor code64 da GDT (ver boot/stage2.asm)
const INT_GATE   = 0x8E;   // present, ring0, interrupt gate

const VECTOR_TIMER    = 0x20;   // IRQ0 (PIT — legado, mascarado)
const VECTOR_KEYBOARD = 0x21;   // IRQ1 (PS/2)
const VECTOR_LAPIC_TIMER = 0x40; // timer do LAPIC (o quantum real)

// registros do LAPIC (xAPIC MMIO via os.lapicRead/Write)
const LAPIC_TPR      = 0x080;
const LAPIC_EOI_REG  = 0x0B0;
const LAPIC_LVT_TIMER     = 0x320;
const LAPIC_LVT_LINT0     = 0x350;
const LAPIC_LVT_LINT1     = 0x360;
const LAPIC_TIMER_DIVIDE  = 0x3E0;
const LAPIC_TIMER_INITIAL = 0x380;
const LAPIC_TIMER_CURRENT = 0x390;

function setGate(vec, handlerAddr) {
    const base = IDT_ADDR + vec * 16;
    os.writePhysical16(base + 0, handlerAddr & 0xFFFF);
    os.writePhysical16(base + 2, CODE64_SEL);
    os.writePhysical8(base + 4, 0);
    os.writePhysical8(base + 5, INT_GATE);
    os.writePhysical16(base + 6, (handlerAddr >> 16) & 0xFFFF);
    os.writePhysical32(base + 8, Math.floor(handlerAddr / 0x100000000) >>> 0);
    os.writePhysical32(base + 12, 0);
}

// ---- deteccao de plataforma (CPUID, so p/ log) ----
function hypervisorVendor() {
    const r = os.cpuid(0x40000000);
    let v = '';
    for (const x of [r[1], r[2], r[3]])
        for (let i = 0; i < 4; i++)
            v += String.fromCharCode((x >> (i * 8)) & 0xFF);
    return v;
}

let idtLoaded = false;
const handlerByVector = new Map();       // vetor -> funcao JS
const lastCountByVector = new Map();     // vetor -> ultima contagem vista

function init() {
    const hypervisorBit = ((os.cpuid(1)[2] >>> 31) & 1) === 1;
    const vendor = hypervisorBit ? hypervisorVendor() : 'hardware real?';
    os.debugPrint('[irq] plataforma: ' + vendor);

    // ORDEM IMPORTA: nenhuma fonte de IRQ pode estar ativa antes da IDT.

    // 1. PIC 8259: master -> 0x20, slave -> 0x28; so IRQ1 (teclado) habilitada
    //    (o timer vem do LAPIC timer, como um SO moderno)
    os.writePort8(0x20, 0x11); os.writePort8(0xA0, 0x11);
    os.writePort8(0x21, 0x20); os.writePort8(0xA1, 0x28);
    os.writePort8(0x21, 0x04); os.writePort8(0xA1, 0x02);
    os.writePort8(0x21, 0x01); os.writePort8(0xA1, 0x01);
    os.writePort8(0x21, 0xFD); os.writePort8(0xA1, 0xFF);

    // 2. constroi a IDT na memoria fisica (0x82000) — TODOS os 256 vetores
    //    (o LAPIC pode entregar spurious 0xFF; vetor sem gate = crash)
    const stubs = os.getIrqStubTable();
    for (let v = 0; v < 256; v++) setGate(v, stubs + v * STUB_SIZE);

    // 3. carrega a IDT e liga interrupcoes (sti dentro do loadIdt)
    os.loadIdt(IDT_ADDR, 256 * 16);
    idtLoaded = true;

    // 4. LAPIC timer: quantum periodico de 100 Hz (calibrado de verdade)
    startLapicTimer();
    os.debugPrint('[irq] IDT carregada; LAPIC timer 100Hz + IRQ1 teclado');
}

// LAPIC timer one-shot para medir a frequencia do bus, depois periodico
function startLapicTimer() {
    // habilita o LAPIC PRIMEIRO (SVR: spurious 0xFF + software enable)
    os.lapicWrite(0xF0, 0x1FF);
    os.lapicWrite(LAPIC_TPR, 0);                    // TPR = 0 (nada mascarado)
    // LINT0 = ExtINT (0x700, NAO mascarado): o caminho do PIC 8259 -> CPU
    // (virtual wire mode) — sem isso a IRQ1 do teclado nao chega no LAPIC
    os.lapicWrite(LAPIC_LVT_LINT0, 0x700);
    os.lapicWrite(LAPIC_LVT_LINT1, 0x400);          // LINT1 = NMI (nao mascarado)
    os.lapicWrite(LAPIC_LVT_TIMER, 0x10000);        // timer mascarado p/ medir
    os.lapicWrite(LAPIC_TIMER_DIVIDE, 0x3);         // divide por 16

    // mede a frequencia do timer do LAPIC com o relogio TSC (50ms one-shot)
    os.lapicWrite(LAPIC_TIMER_CURRENT, 0);          // para o contador
    os.lapicWrite(LAPIC_TIMER_INITIAL, 0xFFFFFFFF);
    const measureEnd = Clock.uptimeMs() + 50;
    while (Clock.uptimeMs() < measureEnd) { }
    const elapsedTicks = 0xFFFFFFFF - os.lapicRead(LAPIC_TIMER_CURRENT);
    os.lapicWrite(LAPIC_LVT_TIMER, 0x10000);        // para (mascara)
    os.lapicWrite(LAPIC_TIMER_CURRENT, 0);
    const ticksPerSecond = elapsedTicks * 20;       // 50ms -> 1s
    const ticksPerQuantum = Math.max(1000, Math.floor(ticksPerSecond / 100));

    // liga o timer periodico no vetor 0x40 a 100 Hz
    os.lapicWrite(LAPIC_LVT_TIMER, VECTOR_LAPIC_TIMER | 0x20000);  // periodic
    os.lapicWrite(LAPIC_TIMER_INITIAL, ticksPerQuantum);
    os.debugPrint('[irq] LAPIC timer: ' + (ticksPerSecond / 1000000).toFixed(1) +
                  ' MHz de bus, ' + ticksPerQuantum + ' ticks/quantum');
}

// ---- registro e dispatch de handlers (o modelo ISR->DPC do NT) ------------

// registra o handler JS de um vetor (0x20=timer, 0x21=teclado...)
function registerIrqHandler(vector, handlerFunction) {
    handlerByVector.set(vector, handlerFunction);
}

// despacha as IRQs pendentes: para cada vetor com contagem nova no hardware,
// chama o handler JS com o numero de ocorrencias pendentes
function dispatchPending() {
    for (const [vector, handlerFunction] of handlerByVector) {
        const count = irqCount(vector);
        const lastCount = lastCountByVector.get(vector) || 0;
        if (count === lastCount) continue;
        lastCountByVector.set(vector, count);
        handlerFunction(vector, count - lastCount);
    }
}

// IRQs estao chegando de verdade? (hardware/emulador entregando)
function irqsArriving() {
    return irqCount(VECTOR_LAPIC_TIMER) > 0;
}

function isAvailable() { return idtLoaded; }

function tickCount() {
    return os.readPhysical32(IRQ_COUNT + VECTOR_LAPIC_TIMER * 4);
}

function irqCount(vector) {
    return os.readPhysical32(IRQ_COUNT + vector * 4);
}

// scancode cru do ring buffer alimentado pela IRQ1 (-1 se vazio)
function pollScancode() {
    const head = os.readPhysical32(KBD_HEAD), tail = os.readPhysical32(KBD_TAIL);
    if (head === tail) return -1;
    const v = os.readPhysical8(KBD_DATA + tail);
    os.writePhysical32(KBD_TAIL, (tail + 1) & 0xFF);
    return v;
}

module.exports = { init, registerIrqHandler, dispatchPending, irqsArriving,
                   isAvailable, tickCount, irqCount, pollScancode,
                   VECTOR_TIMER, VECTOR_KEYBOARD, VECTOR_LAPIC_TIMER };
