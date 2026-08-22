// ===========================================================================
// jsOS - system32/ntos/mm/paging.js: edicao REAL das tabelas de paginas
// x86-64 em JavaScript. Anda PML4->PDPT->PD->PT criando os niveis que faltam
// com frames do PFN (ntos/mm/pfn.js), divide paginas de 2MB em PTs de 4KB
// sob demanda e invalida a TLB via os.invalidatePage/reloadCr3.
//
// Indices de uma VA: PML4[39-47] PDPT[30-38] PD[21-29] PT[12-20].
// ===========================================================================

const MemoryMap = require('ntos/mm/memory-map');
const Pfn = require('ntos/mm/pfn');

const PAGE_PRESENT = 0x01;
const PAGE_RW      = 0x02;
const PAGE_PS      = 0x80;   // bit 7 na PD = pagina de 2MB

const PML4 = MemoryMap.PML4_PHYS;

function readEntry(address) {
    return os.readPhysical32(address) + os.readPhysical32(address + 4) * 0x100000000;
}
function writeEntry(address, value) {
    os.writePhysical32(address, value >>> 0);
    os.writePhysical32(address + 4, Math.floor(value / 0x100000000) >>> 0);
}

function pml4Index(va) { return Math.floor(va / 0x8000000000) & 0x1FF; }
function pdptIndex(va) { return Math.floor(va / 0x40000000) & 0x1FF; }
function pdIndex(va)   { return Math.floor(va / 0x200000) & 0x1FF; }
function ptIndex(va)   { return Math.floor(va / 0x1000) & 0x1FF; }

function zeroFrame(frame) {
    for (let i = 0; i < 512; i++) writeEntry(frame + i * 8, 0);
}

// anda PML4->PDPT->PD ate a entrada da PD que contem `va`.
// create=true: cria os niveis que faltam com frames do PFN.
function pdEntryAddress(va, create) {
    const pml4EntryAddress = PML4 + pml4Index(va) * 8;
    let entry = readEntry(pml4EntryAddress);
    if (!(entry & PAGE_PRESENT)) {
        if (!create) return 0;
        const pdptFrame = Pfn.allocPage();
        if (!pdptFrame) return 0;
        zeroFrame(pdptFrame);
        writeEntry(pml4EntryAddress, pdptFrame | PAGE_PRESENT | PAGE_RW);
    }
    const pdptAddress = readEntry(pml4EntryAddress) & 0xFFFFF000;
    const pdptEntryAddress = pdptAddress + pdptIndex(va) * 8;
    entry = readEntry(pdptEntryAddress);
    if (!(entry & PAGE_PRESENT)) {
        if (!create) return 0;
        const pdFrame = Pfn.allocPage();
        if (!pdFrame) return 0;
        zeroFrame(pdFrame);
        writeEntry(pdptEntryAddress, pdFrame | PAGE_PRESENT | PAGE_RW);
    }
    const pdAddress = readEntry(pdptEntryAddress) & 0xFFFFF000;
    return pdAddress + pdIndex(va) * 8;
}

// traduz VA -> PA andando pelas tabelas (prova real de que o mapeamento existe)
function translate(va) {
    const pdEa = pdEntryAddress(va, false);
    if (!pdEa) return 0;
    const pdEntry = readEntry(pdEa);
    if (!(pdEntry & PAGE_PRESENT)) return 0;
    if (pdEntry & PAGE_PS)
        return (pdEntry & 0xFFFFFFE00000) + (va % 0x200000);
    const ptAddress = pdEntry & 0xFFFFF000;
    const ptEntry = readEntry(ptAddress + ptIndex(va) * 8);
    if (!(ptEntry & PAGE_PRESENT)) return 0;
    return (ptEntry & 0xFFFFF000) + (va % 0x1000);
}

// divide a pagina de 2MB que contem `va` numa PT com 512 paginas de 4KB
// (preservando o mapeamento atual). Retorna true se dividiu/existia.
function splitLargePage(va) {
    const pdEa = pdEntryAddress(va, false);
    if (!pdEa) return false;
    const pdEntry = readEntry(pdEa);
    if (!(pdEntry & PAGE_PRESENT)) return false;
    if (!(pdEntry & PAGE_PS)) return true;   // ja dividida

    const largeBase = pdEntry & 0xFFFFFFE00000;
    const ptFrame = Pfn.allocPage();
    if (!ptFrame) return false;
    for (let i = 0; i < 512; i++)
        writeEntry(ptFrame + i * 8, (largeBase + i * 0x1000) | PAGE_PRESENT | PAGE_RW);
    writeEntry(pdEa, ptFrame | PAGE_PRESENT | PAGE_RW);
    os.reloadCr3();   // flush total da TLB (split muda a estrutura)
    return true;
}

// devolve o endereco fisico da PT que contem `va` (cria/divide se preciso)
function ensurePageTable(va) {
    if (!pdEntryAddress(va, true)) return 0;
    const pdEa = pdEntryAddress(va, false);
    const pdEntry = readEntry(pdEa);
    if (!(pdEntry & PAGE_PRESENT)) {
        const ptFrame = Pfn.allocPage();
        if (!ptFrame) return 0;
        zeroFrame(ptFrame);
        writeEntry(pdEa, ptFrame | PAGE_PRESENT | PAGE_RW);
        return ptFrame;
    }
    if (pdEntry & PAGE_PS) {
        if (!splitLargePage(va)) return 0;
        return readEntry(pdEa) & 0xFFFFF000;
    }
    return pdEntry & 0xFFFFF000;
}

// mapeia uma pagina de 4KB: va -> pa com flags (real, na tabela)
function mapPage(va, pa, flags) {
    const ptAddress = ensurePageTable(va);
    if (!ptAddress) return false;
    writeEntry(ptAddress + ptIndex(va) * 8, (pa & 0xFFFFF000) | flags);
    os.invalidatePage(va);
    return true;
}

function unmapPage(va) {
    const ptAddress = ensurePageTable(va);
    if (!ptAddress) return false;
    writeEntry(ptAddress + ptIndex(va) * 8, 0);
    os.invalidatePage(va);
    return true;
}

module.exports = { translate, splitLargePage, mapPage, unmapPage,
                   PAGE_PRESENT, PAGE_RW };
