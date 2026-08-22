// ===========================================================================
// jsOS - system32/ntos/mm/pfn.js: alocador de frames fisicos de 4KB
// (PFN - Page Frame Number, estilo NT). Bitmap sobre a arena PFN do
// memory-map; alloc/free reais com reuso.
// ===========================================================================

const MemoryMap = require('ntos/mm/memory-map');

const FRAME_SIZE = MemoryMap.PAGE_SIZE;
const BASE = MemoryMap.PFN_BASE;
const TOP = MemoryMap.PFN_TOP;
const FRAME_COUNT = (TOP - BASE) / FRAME_SIZE;

let bitmap = null;   // Uint8Array: 1 = usado

function init() {
    bitmap = new Uint8Array(FRAME_COUNT);
}

function addressOf(index) { return BASE + index * FRAME_SIZE; }
function indexOf(address) { return (address - BASE) / FRAME_SIZE; }

// aloca um frame fisico; retorna endereco ou 0 (sem memoria)
function allocPage() {
    for (let i = 0; i < FRAME_COUNT; i++) {
        if (bitmap[i] === 0) {
            bitmap[i] = 1;
            return addressOf(i);
        }
    }
    return 0;
}

function freePage(address) {
    const i = indexOf(address);
    if (i < 0 || i >= FRAME_COUNT || (address % FRAME_SIZE) !== 0) return false;
    bitmap[i] = 0;
    return true;
}

function freeCount() {
    let n = 0;
    for (let i = 0; i < FRAME_COUNT; i++) if (bitmap[i] === 0) n++;
    return n;
}

function totalCount() { return FRAME_COUNT; }

module.exports = { init, allocPage, freePage, freeCount, totalCount };
