// ===========================================================================
// jsOS - system32/win32/ntoskrnl/mm.js: exports Mm* (memoria do convidado
// real, via a arena gerenciada em win32/guest-memory.js).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const Paging = require('ntos/mm/paging');

// mapeamentos IoSpace ativos: va -> { physicalAddress, size } (aqui VA == PA:
// nossa paginacao e' identity-mapped, entao o "mapeamento" e' real por
// construcao — a tabela existe para rastrear e validar o unmap, como o NT)
const ioSpaceMappings = new Map();

module.exports = {
    names: [
        'MmAllocateNonCachedMemory',
        'MmFreeNonCachedMemory',
        'MmMapIoSpace',
        'MmUnmapIoSpace',
        'MmGetPhysicalAddress',
    ],
    handlers: [
        // MmAllocateNonCachedMemory(size) -> memoria fisica zerada
        (size) => GuestMemory.guestAllocBytes(size),
        // MmFreeNonCachedMemory(pointer, size)
        (pointer, _size) => { GuestMemory.guestFreeBytes(pointer); return 0; },
        // MmMapIoSpace(physicalAddress u64, size, cacheType) -> VA
        // Identity-mapped: a VA devolvida E' o endereco fisico (nossas
        // tabelas de pagina cobrem o espaco fisico inteiro 1:1).
        (physicalAddress, size, _cacheType) => {
            const va = physicalAddress;   // identity
            ioSpaceMappings.set(va >>> 0, {
                physicalAddress, size: size >>> 0,
            });
            return va;
        },
        // MmUnmapIoSpace(va, size): so desfaz se o mapeamento existir (como o NT)
        (virtualAddress, _size) => {
            ioSpaceMappings.delete(virtualAddress >>> 0);
            return 0;
        },
        // MmGetPhysicalAddress(va) -> PA: anda as tabelas de pagina DE VERDADE
        (virtualAddress) => Paging.translate(virtualAddress),
    ],
};
