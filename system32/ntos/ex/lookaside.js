// ===========================================================================
// jsOS - system32/ntos/ex/lookaside.js: lookaside lists (estilo NT).
//
// Cache de blocos de tamanho fixo sobre o pool: o free empilha o bloco na
// lista (next pointer no primeiro dword do proprio bloco livre, como o NT),
// o alloc desempilha; so acima da Depth e' que cai no pool de verdade.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const LIST = NtAbi.LOOKASIDE_LIST;

// ExInitialize*LookasideList(listPtr, alloc, free, flags, size, tag, depth)
function initialize(listPointer, blockSize, tag, depth) {
    for (let i = 0; i < LIST.SIZE; i += 4)
        GuestMemory.writeGuest32(listPointer + i, 0);
    GuestMemory.writeGuest16(listPointer + LIST.DEPTH, depth || 4);
    GuestMemory.writeGuest32(listPointer + LIST.BLOCK_SIZE, blockSize >>> 0);
    GuestMemory.writeGuest32(listPointer + LIST.TAG, tag >>> 0);
    return 0;
}

// ExAllocateFrom*LookasideList(listPtr) -> bloco de BLOCK_SIZE bytes
function allocate(listPointer) {
    const freeHead = GuestMemory.readGuest32(listPointer + LIST.FREE_HEAD);
    GuestMemory.writeGuest32(listPointer + LIST.ALLOC_COUNT,
        GuestMemory.readGuest32(listPointer + LIST.ALLOC_COUNT) + 1);
    if (freeHead) {
        // desempilha: o next esta no primeiro dword do bloco livre
        GuestMemory.writeGuest32(listPointer + LIST.FREE_HEAD,
                                 GuestMemory.readGuest32(freeHead));
        return freeHead;
    }
    return GuestMemory.guestAllocBytes(
        GuestMemory.readGuest32(listPointer + LIST.BLOCK_SIZE));
}

// ExFreeTo*LookasideList(listPtr, blockPtr): cacheia ate a Depth
function free(listPointer, blockPointer) {
    GuestMemory.writeGuest32(listPointer + LIST.FREE_COUNT,
        GuestMemory.readGuest32(listPointer + LIST.FREE_COUNT) + 1);
    const depth = GuestMemory.readGuest16(listPointer + LIST.DEPTH);
    const cachedCount = GuestMemory.readGuest32(listPointer + LIST.ALLOC_COUNT) -
                        GuestMemory.readGuest32(listPointer + LIST.FREE_COUNT);
    if (cachedCount >= depth) {
        GuestMemory.guestFreeBytes(blockPointer);   // acima da depth: pool
        return 0;
    }
    GuestMemory.writeGuest32(blockPointer,
        GuestMemory.readGuest32(listPointer + LIST.FREE_HEAD));
    GuestMemory.writeGuest32(listPointer + LIST.FREE_HEAD, blockPointer >>> 0);
    return 0;
}

// ExDelete*LookasideList(listPtr): esvazia o cache para o pool
function deleteList(listPointer) {
    let blockPointer = GuestMemory.readGuest32(listPointer + LIST.FREE_HEAD);
    while (blockPointer) {
        const next = GuestMemory.readGuest32(blockPointer);
        GuestMemory.guestFreeBytes(blockPointer);
        blockPointer = next;
    }
    GuestMemory.writeGuest32(listPointer + LIST.FREE_HEAD, 0);
    return 0;
}

module.exports = { initialize, allocate, free, deleteList };
