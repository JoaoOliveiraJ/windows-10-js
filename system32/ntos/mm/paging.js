// ===========================================================================
// jsOS - system32/ntos/mm/paging.js: edicao REAL das tabelas de paginas
// x86-64 em JavaScript. As tabelas do stage2 (identity 4GB com paginas de
// 2MB) moram em memoria fisica 0x70000+; o JS le/escreve as entradas, divide
// paginas de 2MB em PTs de 4KB sob demanda e invalida a TLB via primitivas.
//
// Indices de uma VA 64-bit: PML4[39-47] PDPT[30-38] PD[21-29] PT[12-20].
// ===========================================================================

const MemoryMap = require('ntos/mm/memory-map');
const Pfn = require('ntos/mm/pfn');

const PAGE_PRESENT = 0x01;
const PAGE_RW      = 0x02;
const PAGE_PS      = 0x80;   // bit 7 na PD = pagina de 2MB

const PML4 = MemoryMap.PML4_PHYS;
const PDPT = MemoryMap.PDPT_PHYS;
const PD   = MemoryMap.PD_PHYS;

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

// PDPT[i] -> PDi fisico
function pdAddressOf(va) {
    const pdptEntry = readEntry(PDPT + pdptIndex(va) * 8);
    if (!(pdptEntry & PAGE_PRESENT)) return 0;
    return pdptEntry & 0xFFFFF000;   // endereco da PD (4KB alinhada)
}

// traduz VA -> PA andando pelas tabelas (prova real de que o mapeamento existe)
function translate(va) {
    const pml4Entry = readEntry(PML4 + pml4Index(va) * 8);
    if (!(pml4Entry & PAGE_PRESENT)) return 0;
    const pdAddress = pdAddressOf(va);
    if (!pdAddress) return 0;
    const pdEntry = readEntry(pdAddress + pdIndex(va) * 8);
    if (!(pdEntry & PAGE_PRESENT)) return 0;
    if (pdEntry & PAGE_PS)   // pagina grande de 2MB
        return (pdEntry & 0xFFFFFFE00000) + (va % 0x200000);
    // pagina de 4KB via PT
    const ptAddress = pdEntry & 0xFFFFF000;
    const ptEntry = readEntry(ptAddress + ptIndex(va) * 8);
    if (!(ptEntry & PAGE_PRESENT)) return 0;
    return (ptEntry & 0xFFFFF000) + (va % 0x1000);
}

// divide a pagina de 2MB que contem `va` numa PT com 512 paginas de 4KB
// (preservando o mapeamento identity atual). Retorna true se dividiu/existia.
function splitLargePage(va) {
    const pdAddress = pdAddressOf(va);
    if (!pdAddress) return false;
    const pdEntryAddress = pdAddress + pdIndex(va) * 8;
    const pdEntry = readEntry(pdEntryAddress);
    if (!(pdEntry & PAGE_PRESENT) || !(pdEntry & PAGE_PS)) return !!(pdEntry & 1);

    const largeBase = pdEntry & 0xFFFFFFE00000;
    const ptFrame = Pfn.allocPage();
    if (!ptFrame) return false;
    // preenche a PT mapeando o mesmo range fisico em 4KB (identity preservada)
    for (let i = 0; i < 512; i++)
        writeEntry(ptFrame + i * 8, (largeBase + i * 0x1000) | PAGE_PRESENT | PAGE_RW);
    writeEntry(pdEntryAddress, ptFrame | PAGE_PRESENT | PAGE_RW);
    os.reloadCr3();   // flush total da TLB (split muda a estrutura)
    return true;
}

// mapeia uma pagina de 4KB: va -> pa com flags (real, na tabela)
function mapPage(va, pa, flags) {
    if (!splitLargePage(va)) return false;
    const pdAddress = pdAddressOf(va);
    const pdEntry = readEntry(pdAddress + pdIndex(va) * 8);
    const ptAddress = pdEntry & 0xFFFFF000;
    writeEntry(ptAddress + ptIndex(va) * 8, (pa & 0xFFFFF000) | flags);
    os.invalidatePage(va);
    return true;
}

function unmapPage(va) {
    const pdAddress = pdAddressOf(va);
    if (!pdAddress) return false;
    const pdEntry = readEntry(pdAddress + pdIndex(va) * 8);
    if (!(pdEntry & PAGE_PRESENT) || (pdEntry & PAGE_PS)) return false;
    const ptAddress = pdEntry & 0xFFFFF000;
    writeEntry(ptAddress + ptIndex(va) * 8, 0);
    os.invalidatePage(va);
    return true;
}

module.exports = { translate, splitLargePage, mapPage, unmapPage,
                   PAGE_PRESENT, PAGE_RW };
