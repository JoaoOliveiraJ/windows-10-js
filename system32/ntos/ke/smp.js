// ===========================================================================
// jsOS - system32/ntos/ke/smp.js: SMP real — descoberta de CPUs via ACPI
// (RSDP/RSDT/MADT), startup dos APs com INIT-SIPI-SIPI pelo LAPIC (MMIO
// 0xFEE00000) e execucao paralela de codigo nativo via mailbox de jobs.
//
// Divisao de trabalho: TODA a logica aqui e JS (tabelas ACPI, sequencia de
// IPIs, agendamento de jobs); o asm (boot/aptrampoline.asm) so faz a troca
// de modos do AP e o loop de jobs — e o minimo fisico possivel.
//
// Mailbox em 0xA000 (ver memory-map.js), layout casado com o trampolim:
//   +0x00 magic 'JSMP'   +0x04 CPUs online   +0x08 ack do boot
//   +0x0C slot do boot   +0x10 stack do boot +0x18 CR3
//   +0x100... registros de 64B por CPU:
//     +0x00 apicId  +0x04 online  +0x08 jobFunc  +0x10..0x28 args 1..4
//     +0x30 resultado  +0x38 jobDone
// ===========================================================================

const MemoryMap = require('ntos/mm/memory-map');
const Clock = require('ntos/ke/clock');

const MAILBOX = MemoryMap.SMP_MAILBOX_PHYS;
const TRAMPOLINE = MemoryMap.AP_TRAMPOLINE_PHYS;

const MB_MAGIC = 0x00, MB_ONLINE = 0x04, MB_ACK = 0x08, MB_BOOTSLOT = 0x0C;
const MB_BOOTSTACK = 0x10, MB_CR3 = 0x18, MB_SLOTS = 0x100;
const SLOT_SIZE = 64;
const SLOT_APIC_ID = 0x00, SLOT_ONLINE = 0x04, SLOT_JOB_FUNC = 0x08;
const SLOT_JOB_ARG1 = 0x10, SLOT_JOB_ARG2 = 0x18, SLOT_JOB_ARG3 = 0x20;
const SLOT_JOB_ARG4 = 0x28, SLOT_JOB_RES = 0x30, SLOT_JOB_DONE = 0x38;
const SMP_MAGIC = 0x4A534D50;   // 'JSMP'

const LAPIC_SVR = 0xF0, LAPIC_ICR_LO = 0x300, LAPIC_ICR_HI = 0x310;
const ICR_INIT_ASSERT = 0xC500;   // INIT, level, assert
const ICR_INIT_DEASSERT = 0x8500; // INIT, level, deassert
const ICR_SIPI = 0x4600;          // STARTUP, edge, assert | vetor
const ICR_NMI = 0x4400;           // NMI, edge, assert (acorda vCPU no WHPX)

let bspApicId = 0;
let discoveredApicIds = [];       // todos os CPUs da MADT (inclui o BSP)
let onlineApSlots = [];           // slots de AP que responderam ao SIPI
let initialized = false;

// ---- utilitarios de memoria fisica --------------------------------------
function readPhys64(address) {
    return os.readPhysical32(address) +
           os.readPhysical32(address + 4) * 0x100000000;
}
function writePhys64(address, value) {
    os.writePhysical32(address, value >>> 0);
    os.writePhysical32(address + 4, Math.floor(value / 0x100000000));
}
function waitMs(ms) { Clock.spinMs(ms); }   // TSC de alta resolucao

// ---- LAPIC (xAPIC MMIO via primitivas dedicadas — WHPX precisa decodificar
// a instrucao de acesso; ver hal/qjs/primitives_irq.c) -----------------------
function lapicRead(reg) { return os.lapicRead(reg) >>> 0; }
function lapicWrite(reg, value) { os.lapicWrite(reg, value >>> 0); }

// envia IPI fisico para um APIC ID e espera o delivery status limpar
function sendIpi(apicId, icrLow) {
    lapicWrite(LAPIC_ICR_HI, (apicId & 0xFF) * 0x1000000);
    lapicWrite(LAPIC_ICR_LO, icrLow >>> 0);
    for (let i = 0; i < 100000; i++)
        if (!(lapicRead(LAPIC_ICR_LO) & 0x1000)) return true;
    return false;
}

// broadcast (shorthand 3 = all-excluding-self) — experimento de plataforma
function broadcastIpi(icrLow) {
    lapicWrite(LAPIC_ICR_LO, (icrLow | 0xC0000) >>> 0);
    for (let i = 0; i < 100000; i++)
        if (!(lapicRead(LAPIC_ICR_LO) & 0x1000)) return true;
    return false;
}

// ---- ACPI: RSDP -> RSDT -> MADT -------------------------------------------
function readAscii8(address) {
    let text = '';
    for (let i = 0; i < 8; i++)
        text += String.fromCharCode(os.readPhysical8(address + i));
    return text;
}

// RSDP na area 0xE0000-0xFFFFF (boundary de 16B), checksum de 20 bytes
function findRsdp() {
    for (let address = 0xE0000; address < 0x100000; address += 16) {
        if (readAscii8(address) !== 'RSD PTR ') continue;
        let sum = 0;
        for (let i = 0; i < 20; i++) sum += os.readPhysical8(address + i);
        if ((sum & 0xFF) === 0) return address;
    }
    return 0;
}

function tableLength(address) { return os.readPhysical32(address + 4) >>> 0; }

// varre a MADT coletando os LAPICs habilitados (type 0 e x2APIC type 9)
function parseMadt(madtAddress) {
    const apicIds = [];
    const length = tableLength(madtAddress);
    let cursor = madtAddress + 44;   // header 36 + lapic addr 4 + flags 4
    const end = madtAddress + length;
    while (cursor + 2 <= end) {
        const type = os.readPhysical8(cursor);
        const size = os.readPhysical8(cursor + 1);
        if (size < 2) break;
        if (type === 0 && size >= 8) {          // Processor Local APIC
            const apicId = os.readPhysical8(cursor + 3);
            const flags = os.readPhysical32(cursor + 4) >>> 0;
            if (flags & 1) apicIds.push(apicId);
        } else if (type === 9 && size >= 16) {  // Processor Local x2APIC
            const apicId = os.readPhysical32(cursor + 4) >>> 0;
            const flags = os.readPhysical32(cursor + 8) >>> 0;
            if (flags & 1) apicIds.push(apicId);
        }
        cursor += size;
    }
    return apicIds;
}

// lista de APIC IDs de todos os CPUs presentes (ou [bsp] sem ACPI)
function discoverCpus() {
    const rsdp = findRsdp();
    if (!rsdp) { os.debugPrint('[smp] RSDP nao encontrado'); return []; }
    const rsdt = os.readPhysical32(rsdp + 16) >>> 0;
    if (readAscii8(rsdt).slice(0, 4) !== 'RSDT') return [];
    const entryCount = Math.floor((tableLength(rsdt) - 36) / 4);
    for (let i = 0; i < entryCount; i++) {
        const table = os.readPhysical32(rsdt + 36 + i * 4) >>> 0;
        if (readAscii8(table).slice(0, 4) === 'APIC')
            return parseMadt(table);
    }
    return [];
}

// ---- startup dos APs ------------------------------------------------------
function installTrampoline() {
    const bytes = os.readBundleBytes('boot/aptrampoline.bin');
    if (!bytes) throw new Error('boot/aptrampoline.bin ausente no bundle');
    for (let i = 0; i < bytes.length; i++)
        os.writePhysical8(TRAMPOLINE + i, bytes[i]);
    for (let i = 0; i < 0x1000; i += 4) os.writePhysical32(MAILBOX + i, 0);
    os.writePhysical32(MAILBOX + MB_MAGIC, SMP_MAGIC);
    writePhys64(MAILBOX + MB_CR3, MemoryMap.PML4_PHYS);
    // IVT[2] (NMI) -> stub iret no trampolim (CS=0x900, IP=0x40), ver startAp
    os.writePhysical16(0x08, TRAMPOLINE + 0x40);
    os.writePhysical16(0x0A, TRAMPOLINE >> 4);
}

// INIT-SIPI-SIPI (Intel MP spec 3.7.3) + NMI final para um AP.
// O NMI existe por causa de uma limitacao do WHPX: com kernel-irqchip=off o
// SIPI e processado (segmentos carregados) mas o "halted" interno do vCPU
// nao e limpo — um NMI limpa (caminho CPU_INTERRUPT_NMI do whpx). O NMI cai
// no IVT[2] = iret do trampolim, sem efeito colateral; em hardware real o
// NMI simplesmente nao chega (APIC filtra ate o SIPI completar).
function startAp(slotIndex, apicId) {
    const vector = ICR_SIPI | (TRAMPOLINE >> 12);
    os.writePhysical32(MAILBOX + MB_ACK, 0);
    os.writePhysical32(MAILBOX + MB_BOOTSLOT, slotIndex);
    writePhys64(MAILBOX + MB_BOOTSTACK,
                MemoryMap.AP_STACK_BASE +
                (slotIndex + 1) * MemoryMap.AP_STACK_SIZE);

    sendIpi(apicId, ICR_INIT_ASSERT);
    waitMs(10);                              // INIT precisa de ~10ms
    sendIpi(apicId, ICR_INIT_DEASSERT);
    waitMs(1);
    sendIpi(apicId, vector);
    waitMs(1);
    sendIpi(apicId, vector);                 // segundo SIPI (spec)
    sendIpi(apicId, ICR_NMI);                // WHPX: limpa o halt do vCPU

    // fallback: broadcast (modo APIC no hipervisor as vezes so entrega assim)
    if (!os.readPhysical32(MAILBOX + MB_ACK)) {
        broadcastIpi(ICR_INIT_ASSERT);
        waitMs(10);
        broadcastIpi(ICR_INIT_DEASSERT);
        waitMs(1);
        broadcastIpi(vector);
        waitMs(1);
        broadcastIpi(vector);
    }

    const deadline = Clock.nowMs() + 500;
    while (Clock.nowMs() < deadline)
        if (os.readPhysical32(MAILBOX + MB_ACK)) return true;
    return false;
}

function init() {
    discoveredApicIds = discoverCpus();
    bspApicId = (lapicRead(0x20) >>> 24) & 0xFF;
    if (discoveredApicIds.length === 0) discoveredApicIds = [bspApicId];
    if (discoveredApicIds.indexOf(bspApicId) < 0)
        discoveredApicIds.unshift(bspApicId);

    // diagnostico real: o LAPIC existe MESMO? o registro Version (0x30) e
    // somente leitura — se aceitar escrita, a regiao e RAM comum (sem APIC)
    const lapicVersion = lapicRead(0x30);
    lapicWrite(0x30, 0xDEADBEEF);
    const lapicReal = lapicRead(0x30) === lapicVersion && (lapicVersion & 0xFF) >= 0x10;
    os.debugPrint('[smp] LAPIC version=0x' + lapicVersion.toString(16) +
                  (lapicReal ? '' : ' REGIAO NAO INTERCEPTADA (RAM)'));

    const apCount = discoveredApicIds.length - 1;
    os.debugPrint('[smp] CPUs na MADT: ' + discoveredApicIds.length +
                  ' (BSP apicId=' + bspApicId + ', APs=' + apCount + ')');
    if (apCount === 0) { initialized = true; return; }

    installTrampoline();
    lapicWrite(LAPIC_SVR, lapicRead(LAPIC_SVR) | 0x100);  // APIC sw enable

    const apList = discoveredApicIds.filter(id => id !== bspApicId)
                                    .slice(0, MemoryMap.MAX_CPUS - 1);
    for (let slot = 0; slot < apList.length; slot++) {
        if (startAp(slot, apList[slot])) {
            const record = MAILBOX + MB_SLOTS + slot * SLOT_SIZE;
            const reportedId = os.readPhysical32(record + SLOT_APIC_ID) >>> 0;
            os.debugPrint('[smp] CPU ' + (slot + 1) + ' online (apicId=' +
                          reportedId + ')');
            onlineApSlots.push(slot);
        } else {
            os.debugPrint('[smp] AP apicId=' + apList[slot] +
                          ' NAO respondeu ao SIPI (marcadores 16/32/64: ' +
                          os.readPhysical32(MAILBOX + 0x20) + '/' +
                          os.readPhysical32(MAILBOX + 0x24) + '/' +
                          os.readPhysical32(MAILBOX + 0x28) + ')');
        }
    }
    initialized = true;
}

// ---- jobs nativos nos APs -------------------------------------------------
function slotRecord(slot) { return MAILBOX + MB_SLOTS + slot * SLOT_SIZE; }

function waitJobFree(slot, timeoutMs) {
    const deadline = Clock.nowMs() + timeoutMs;
    while (Clock.nowMs() < deadline)
        if (os.readPhysical32(slotRecord(slot) + SLOT_JOB_DONE)) return true;
    return false;
}

// posta um job (func MS ABI + 4 args) no AP `slot`; retorna false se ocupado
function startJob(slot, functionPointer, arg1, arg2, arg3, arg4) {
    if (onlineApSlots.indexOf(slot) < 0) throw new Error('AP slot ' + slot + ' offline');
    if (!waitJobFree(slot, 5000)) return false;
    const record = slotRecord(slot);
    writePhys64(record + SLOT_JOB_ARG1, arg1 || 0);
    writePhys64(record + SLOT_JOB_ARG2, arg2 || 0);
    writePhys64(record + SLOT_JOB_ARG3, arg3 || 0);
    writePhys64(record + SLOT_JOB_ARG4, arg4 || 0);
    os.writePhysical32(record + SLOT_JOB_DONE, 0);
    writePhys64(record + SLOT_JOB_FUNC, functionPointer);   // por ultimo (release)
    return true;
}

// espera o fim do job e devolve o resultado (u64 como numero)
function waitJob(slot, timeoutMs) {
    const record = slotRecord(slot);
    const deadline = Clock.nowMs() + (timeoutMs || 30000);
    while (Clock.nowMs() < deadline)
        if (os.readPhysical32(record + SLOT_JOB_DONE))
            return readPhys64(record + SLOT_JOB_RES);
    throw new Error('timeout esperando job do AP slot ' + slot);
}

// sincrono: posta e espera
function runOnAp(slot, functionPointer, arg1, arg2, arg3, arg4) {
    startJob(slot, functionPointer, arg1, arg2, arg3, arg4);
    return waitJob(slot);
}

// ---- consultas ------------------------------------------------------------
function discoveredCpuCount() { return discoveredApicIds.length || 1; }
function onlineCpuCount() { return 1 + onlineApSlots.length; }
function apSlotCount() { return onlineApSlots.length; }
function apSlot(index) { return onlineApSlots[index]; }

module.exports = { init, discoveredCpuCount, onlineCpuCount, apSlotCount,
                   apSlot, startJob, waitJob, runOnAp,
                   bspApicId: () => bspApicId };
