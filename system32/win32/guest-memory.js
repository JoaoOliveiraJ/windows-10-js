// ===========================================================================
// jsOS - system32/win32/guest-memory.js: arena de memoria dos convidados
// (drivers .sys e structs NT). Arena de 16MB alocada do heap do kernel no
// boot; o free-list abaixo sub-aloca com split + coalesce (estilo K&R).
//
// Header de bloco (16B): +0 u32 size, +8 u32 next, +12 u32 free.
// ===========================================================================

const ARENA_SIZE = 0x1000000;   // 16MB
const BLOCK_HEADER_SIZE = 16;

let arenaBase = 0;
let heapReady = false;

function readBlockSize(address)  { return os.readPhysical32(address); }
function readBlockNext(address)  { return os.readPhysical32(address + 8); }
function readBlockFree(address)  { return os.readPhysical32(address + 12); }
function writeBlock(address, size, next, free) {
    os.writePhysical32(address, size);
    os.writePhysical32(address + 8, next);
    os.writePhysical32(address + 12, free);
}

function initGuestHeap() {
    arenaBase = os.getGuestArenaBase();
    writeBlock(arenaBase, ARENA_SIZE - BLOCK_HEADER_SIZE, 0, 1);
    heapReady = true;
}

// leituras/escritas de convidado com nomes explicitos
function readGuest8(address)  { return os.readPhysical8(address); }
function readGuest16(address) { return os.readPhysical16(address); }
function readGuest32(address) { return os.readPhysical32(address); }
function readGuest64(address) {
    return os.readPhysical32(address) + os.readPhysical32(address + 4) * 0x100000000;
}
function writeGuest8(address, value)  { os.writePhysical8(address, value & 0xFF); }
function writeGuest16(address, value) { os.writePhysical16(address, value & 0xFFFF); }
function writeGuest32(address, value) { os.writePhysical32(address, value >>> 0); }
function writeGuest64(address, value) {
    writeGuest32(address, value >>> 0);
    writeGuest32(address + 4, Math.floor(value / 0x100000000) >>> 0);
}

// aloca `size` bytes alinhados a `align`; retorna endereco fisico ou 0.
// zero=true (padrao) zera o bloco; zero=false devolve o conteudo antigo
// (ExAllocatePoolUninitialized de verdade: lixo de frees anteriores).
function guestAllocAligned(size, align, zero) {
    if (!heapReady) initGuestHeap();
    let block = arenaBase;
    while (block) {
        if (readBlockFree(block)) {
            const dataStart = block + BLOCK_HEADER_SIZE;
            let aligned = (dataStart + align - 1) & ~(align - 1);
            let padding = aligned - dataStart;
            if (padding > 0 && padding < BLOCK_HEADER_SIZE + 16) {
                aligned += align;
                padding += align;
            }
            const available = readBlockSize(block);
            if (available >= padding + size) {
                const oldNext = readBlockNext(block);
                if (padding >= BLOCK_HEADER_SIZE + 16) {
                    writeBlock(block, padding - BLOCK_HEADER_SIZE,
                               aligned - BLOCK_HEADER_SIZE, 1);
                    writeBlock(aligned - BLOCK_HEADER_SIZE, available - padding,
                               oldNext, 1);
                    block = aligned - BLOCK_HEADER_SIZE;
                }
                const remaining = readBlockSize(block) - size - BLOCK_HEADER_SIZE;
                if (remaining >= 16) {
                    const nextBlock = block + BLOCK_HEADER_SIZE + size;
                    writeBlock(nextBlock, remaining - BLOCK_HEADER_SIZE,
                               readBlockNext(block), 1);
                    writeBlock(block, size, nextBlock, 0);
                } else {
                    writeBlock(block, readBlockSize(block), readBlockNext(block), 0);
                }
                if (zero !== false)
                    for (let i = 0; i < size; i += 4)
                        writeGuest32(block + BLOCK_HEADER_SIZE + i, 0);
                return block + BLOCK_HEADER_SIZE;
            }
        }
        block = readBlockNext(block);
    }
    return 0;   // sem memoria
}

function guestAllocPage()  { return guestAllocAligned(0x1000, 0x1000, true); }
function guestAllocBytes(size) { return guestAllocAligned(size, 16, true); }
function guestAllocRaw(size)   { return guestAllocAligned(size, 16, false); }

function guestFreeBytes(pointer) {
    if (!pointer) return;
    const block = pointer - BLOCK_HEADER_SIZE;
    writeGuest32(block + 12, 1);
    const next = readBlockNext(block);
    if (next && readBlockFree(next) &&
        block + BLOCK_HEADER_SIZE + readBlockSize(block) === next) {
        writeBlock(block, readBlockSize(block) + BLOCK_HEADER_SIZE + readBlockSize(next),
                   readBlockNext(next), 1);
    }
}

module.exports = { guestAllocPage, guestAllocBytes, guestAllocRaw, guestFreeBytes,
                   readGuest8, readGuest16, readGuest32, readGuest64,
                   writeGuest8, writeGuest16, writeGuest32, writeGuest64 };
