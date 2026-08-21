// ===========================================================================
// jsOS - system32/nano/irq.js: gerente de interrupcoes do nanokernel.
//
// 100% JS: constroi a IDT na memoria fisica (0x82000), programa o PIC 8259
// e o PIT (100 Hz) pelas portas, e carrega a tabela com os.loadIdt().
// Os trampolins asm (hal/core/irqstubs.asm) so registram o evento em memoria
// compartilhada; TODA a leitura/politica de interrupcoes e feita aqui.
//
// Memoria compartilhada (ver irqstubs.asm):
//   0x81000: contagem por vetor (u32 cada)   0x81100: ring buffer do teclado
// ===========================================================================

const IDT_ADDR  = 0x82000;
const STUB_SIZE = 10;
const IRQ_COUNT = 0x81000;
const KBD_HEAD  = 0x81100, KBD_TAIL = 0x81104, KBD_DATA = 0x81108;

const CODE64_SEL = 0x18;   // seletor code64 da GDT (ver boot/stage2.asm)
const INT_GATE   = 0x8E;   // present, ring0, interrupt gate

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

// ---- deteccao de plataforma (CPUID) ----
// TCG reporta bit de hipervisor + vendor "TCGTCGTCGTCG" -> IRQs completas.
// WHPX esconde o hipervisor e nao entrega IRQs de PIC/LAPIC para kernels
// custom (wrmsr APIC_BASE derruba o VP) -> modo polling.
// Hardware real: polling por enquanto (limitacao documentada no README).
function hypervisorVendor() {
    const r = os.cpuid(0x40000000);
    let v = '';
    for (const x of [r[1], r[2], r[3]])
        for (let i = 0; i < 4; i++)
            v += String.fromCharCode((x >> (i * 8)) & 0xFF);
    return v;
}

const hypervisorBit = ((os.cpuid(1)[2] >>> 31) & 1) === 1;
const hv = hypervisorBit ? hypervisorVendor() : '';
const available = hypervisorBit && hv.indexOf('TCG') === 0;

function isAvailable() { return available; }

function init() {
    if (!available) {
        os.debugPrint('[irq] modo polling (plataforma sem entrega de IRQ)');
        return;
    }
    os.debugPrint('[irq] interrupcoes ligadas (IDT construida em JS)');

    // ORDEM IMPORTA: nenhuma fonte de IRQ pode estar ativa antes da IDT.

    // 1. PIC 8259: master -> 0x20, slave -> 0x28; IRQ0 (timer) + IRQ1 (teclado)
    os.writePort8(0x20, 0x11); os.writePort8(0xA0, 0x11);
    os.writePort8(0x21, 0x20); os.writePort8(0xA1, 0x28);
    os.writePort8(0x21, 0x04); os.writePort8(0xA1, 0x02);
    os.writePort8(0x21, 0x01); os.writePort8(0xA1, 0x01);
    os.writePort8(0x21, 0xFC); os.writePort8(0xA1, 0xFF);

    // 2. constroi a IDT na memoria fisica (0x82000)
    const stubs = os.getIrqStubTable();
    for (let v = 0; v < 48; v++) setGate(v, stubs + v * STUB_SIZE);

    // 3. carrega a IDT e liga interrupcoes
    os.loadIdt(IDT_ADDR, 256 * 16);

    // 4. PIT canal 0 -> 100 Hz (por ultimo: so com a IDT pronta)
    os.writePort8(0x43, 0x36);
    os.writePort8(0x40, 0x9B);
    os.writePort8(0x40, 0x2E);
}

function tickCount() {
    return os.readPhysical32(IRQ_COUNT + 0x20 * 4);   // vetor 0x20 = IRQ0 timer
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

module.exports = { init, tickCount, irqCount, pollScancode, isAvailable };
