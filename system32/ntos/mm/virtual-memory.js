// ===========================================================================
// jsOS - system32/ntos/mm/virtual-memory.js: VirtualAlloc/VirtualFree do jsOS.
//
// Aloca paginas virtuais no espaco VA reservado (256MB-512MB), cada uma
// lastreada por um frame fisico do PFN (ntos/mm/pfn.js) e mapeada na tabela
// de paginas de verdade (ntos/mm/paging.js). Com free-list de VAs com reuso.
// ===========================================================================

const MemoryMap = require('ntos/mm/memory-map');
const Pfn = require('ntos/mm/pfn');
const Paging = require('ntos/mm/paging');

const VA_BASE = MemoryMap.VA_ALLOC_BASE;
const VA_TOP  = MemoryMap.VA_ALLOC_TOP;
const PAGE = MemoryMap.PAGE_SIZE;

let nextFreeVa = VA_BASE;
const freeRanges = [];   // { va, pages } liberados, reusados primeiro

// aloca `size` bytes (arredonda a paginas); retorna VA ou 0
function alloc(size) {
    const pages = Math.ceil(size / PAGE);
    let va = 0;
    // reusa um range livre exato se houver
    const i = freeRanges.findIndex(r => r.pages === pages);
    if (i >= 0) {
        va = freeRanges[i].va;
        freeRanges.splice(i, 1);
    } else {
        if (nextFreeVa + pages * PAGE > VA_TOP) return 0;
        va = nextFreeVa;
        nextFreeVa += pages * PAGE;
    }
    for (let p = 0; p < pages; p++) {
        const frame = Pfn.allocPage();
        if (!frame || !Paging.mapPage(va + p * PAGE, frame, Paging.PAGE_PRESENT | Paging.PAGE_RW)) {
            // desfaz o que ja foi mapeado
            for (let q = 0; q < p; q++) {
                Pfn.freePage(Paging.translate(va + q * PAGE) & ~0xFFF);
                Paging.unmapPage(va + q * PAGE);
            }
            return 0;
        }
    }
    return va;
}

function free(va, size) {
    const pages = Math.ceil(size / PAGE);
    for (let p = 0; p < pages; p++) {
        const pa = Paging.translate(va + p * PAGE);
        if (pa) {
            Pfn.freePage(pa & ~0xFFF);
            Paging.unmapPage(va + p * PAGE);
        }
    }
    freeRanges.push({ va, pages });
}

module.exports = { alloc, free };
