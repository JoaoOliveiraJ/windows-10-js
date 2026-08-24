// ===========================================================================
// jsOS - system32/win32/ntoskrnl/mm.js: exports Mm* (memoria do convidado
// real, via a arena gerenciada em win32/guest-memory.js).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const Paging = require('ntos/mm/paging');
const NtAbi = require('win32/nt-abi');

// o resolvedor de exports do kernel (registrado pelo ntoskrnl.js ao montar a
// tabela — quebra o ciclo ntoskrnl<->mm sem require dentro de funcao)
let kernelExportLookup = null;
function registerRoutineLookup(lookupFunction) {
    kernelExportLookup = lookupFunction;
}

// mapeamentos IoSpace ativos: va -> { physicalAddress, size } (aqui VA == PA:
// nossa paginacao e' identity-mapped, entao o "mapeamento" e' real por
// construcao — a tabela existe para rastrear e validar o unmap, como o NT)
const ioSpaceMappings = new Map();

// reserved mappings (MmAllocateMappingAddress): va -> { size, tag }
const reservedMappings = new Map();

// secoes paginaveis travadas (MmLockPagableDataSection): nossas imagens sao
// residentes — o conjunto existe p/ a semantica de handle (lock/unlock)
const lockedPagableSections = new Set();

// preenche o PFN array de um MDL andando as tabelas de pagina de verdade
// (uma PFN u64 por pagina coberta pelo buffer)
function fillMdlPfnArray(mdlPointer) {
    const MDL = NtAbi.MDL;
    const startVa = GuestMemory.readGuest64(mdlPointer + MDL.START_VA);
    const byteOffset = GuestMemory.readGuest32(mdlPointer + MDL.BYTE_OFFSET);
    const byteCount = GuestMemory.readGuest32(mdlPointer + MDL.BYTE_COUNT);
    const firstVa = startVa + byteOffset;
    const pageCount = Math.ceil(((firstVa & 0xFFF) + byteCount) / 0x1000);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        const physicalAddress = Paging.translate(
            (firstVa & ~0xFFF) + pageIndex * 0x1000);
        GuestMemory.writeGuest64(mdlPointer + MDL.PFN_ARRAY + pageIndex * 8,
                                 Math.floor(physicalAddress / 0x1000));
    }
}

module.exports = {
    names: [
        'MmAllocateNonCachedMemory',
        'MmFreeNonCachedMemory',
        'MmMapIoSpace',
        'MmUnmapIoSpace',
        'MmGetPhysicalAddress',
        'MmGetSystemAddressForMdlSafe',
        'MmGetSystemRoutineAddress',
        'MmMapLockedPagesSpecifyCache',
        'MmUnmapLockedPages',
        'MmMapIoSpaceEx',                  // (physAddr, size, protect) -> VA
        'MmProbeAndLockPages',             // (mdl, accessMode, operation)
        'MmUnlockPages',                   // (mdl)
        'MmBuildMdlForNonPagedPool',       // (mdl)
        'MmAllocateMappingAddress',        // (size, tag) -> VA reservada
        'MmFreeMappingAddress',            // (va, tag)
        'MmMapLockedPagesWithReservedMapping', // (va, tag, mdl, cache) -> VA
        'MmUnmapReservedMapping',          // (va, tag, mdl)
        'MmLockPagableDataSection',        // (address) -> handle
        'MmUnlockPagableImageSection',     // (address)
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
        // MmGetSystemAddressForMdlSafe(mdlPtr, priority) -> VA mapeada
        // (identity: MappedSystemVa ja e' o endereco virtual)
        (mdlPointer, _priority) =>
            GuestMemory.readGuest64(mdlPointer + NtAbi.MDL.MAPPED_SYSTEM_VA),
        // MmGetSystemRoutineAddress(uniPtr) -> endereco chamavel do export
        // (o trampolim que despacha p/ o handler JS — como o GetProcAddress
        // de kernel do NT)
        (unicodePointer) => {
            const routineName = GuestStrings.readUnicodeString(unicodePointer);
            const apiId = kernelExportLookup('', routineName);
            if (apiId < 0) {
                os.debugPrint('[mm] MmGetSystemRoutineAddress NAO ACHOU: ' +
                              routineName);
                return 0;
            }
            return os.getWin32ThunkTable() + apiId * 10;   // stub de 10 bytes
        },
        // MmMapLockedPagesSpecifyCache(mdl, mode, cache, baseAddr, bugCheck,
        //                              priority) -> VA: mapeia as paginas do
        // MDL; identity-mapped: StartVa + ByteOffset (grava no MDL, como o NT)
        (mdlPointer, _accessMode, _cacheType, requestedAddress, _bugCheck,
         _priority) => {
            const MDL = NtAbi.MDL;
            const startVa = GuestMemory.readGuest64(mdlPointer + MDL.START_VA);
            const byteOffset = GuestMemory.readGuest32(mdlPointer + MDL.BYTE_OFFSET);
            const mappedAddress = requestedAddress || (startVa + byteOffset);
            GuestMemory.writeGuest64(mdlPointer + MDL.MAPPED_SYSTEM_VA,
                                     mappedAddress);
            GuestMemory.writeGuest16(mdlPointer + MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + MDL.MDL_FLAGS) |
                MDL.FLAG_MAPPED_TO_SYSTEM_VA);
            return mappedAddress;
        },
        // MmUnmapLockedPages(va, mdl): limpa a flag de mapeado
        (_virtualAddress, mdlPointer) => {
            const MDL = NtAbi.MDL;
            GuestMemory.writeGuest16(mdlPointer + MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + MDL.MDL_FLAGS) &
                ~MDL.FLAG_MAPPED_TO_SYSTEM_VA);
            return 0;
        },
        // MmMapIoSpaceEx(physAddr u64, size, protect) -> VA: nosso mapa e'
        // identidade 1:1 nas regioes de MMIO — a VA retornada e' o proprio
        // endereco fisico (como um NT com tudo mapeado)
        (physicalAddress, _size, _protect) => physicalAddress,
        // MmProbeAndLockPages(mdl, accessMode, operation): nosso pool/arena
        // e' residente e nao-paginavel — as paginas JA estao "locked" de
        // fato; preenchemos o PFN array de verdade e marcamos o MDL
        (mdlPointer, _accessMode, _operation) => {
            fillMdlPfnArray(mdlPointer);
            GuestMemory.writeGuest16(mdlPointer + NtAbi.MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + NtAbi.MDL.MDL_FLAGS) |
                NtAbi.MDL.FLAG_PAGES_LOCKED);
            return 0;
        },
        // MmUnlockPages(mdl): limpa a marca de travado
        (mdlPointer) => {
            GuestMemory.writeGuest16(mdlPointer + NtAbi.MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + NtAbi.MDL.MDL_FLAGS) &
                ~NtAbi.MDL.FLAG_PAGES_LOCKED);
            return 0;
        },
        // MmBuildMdlForNonPagedPool(mdl): o buffer ja' e' pool nao-paginado
        // (residente por construcao): PFNs reais + flags de origem
        (mdlPointer) => {
            fillMdlPfnArray(mdlPointer);
            GuestMemory.writeGuest16(mdlPointer + NtAbi.MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + NtAbi.MDL.MDL_FLAGS) |
                NtAbi.MDL.FLAG_SOURCE_NONPAGED | NtAbi.MDL.FLAG_PAGES_LOCKED);
            return 0;
        },
        // MmAllocateMappingAddress(size, tag) -> VA reservada: alocada do
        // guest pool (identidade) e registrada — fica FORA do alcance de
        // outras alocacoes ate o free, como a VA reservada do NT
        (size, tag) => {
            const va = GuestMemory.guestAllocBytes(size);
            if (!va) return 0;
            reservedMappings.set(va >>> 0, { size: size >>> 0, tag: tag >>> 0 });
            return va;
        },
        // MmFreeMappingAddress(va, tag)
        (virtualAddress, _tag) => {
            reservedMappings.delete(virtualAddress >>> 0);
            GuestMemory.guestFreeBytes(virtualAddress);
            return 0;
        },
        // MmMapLockedPagesWithReservedMapping(va, tag, mdl, cacheType) -> VA:
        // exige a VA reservada (como o NT); grava no MDL e marca mapeado
        (virtualAddress, _tag, mdlPointer, _cacheType) => {
            if (!reservedMappings.has(virtualAddress >>> 0)) return 0;
            const MDL = NtAbi.MDL;
            const byteOffset = GuestMemory.readGuest32(mdlPointer + MDL.BYTE_OFFSET);
            const mappedAddress = virtualAddress + byteOffset;
            GuestMemory.writeGuest64(mdlPointer + MDL.MAPPED_SYSTEM_VA,
                                     mappedAddress);
            GuestMemory.writeGuest16(mdlPointer + MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + MDL.MDL_FLAGS) |
                MDL.FLAG_MAPPED_TO_SYSTEM_VA);
            return mappedAddress;
        },
        // MmUnmapReservedMapping(va, tag, mdl)
        (_virtualAddress, _tag, mdlPointer) => {
            const MDL = NtAbi.MDL;
            GuestMemory.writeGuest16(mdlPointer + MDL.MDL_FLAGS,
                GuestMemory.readGuest16(mdlPointer + MDL.MDL_FLAGS) &
                ~MDL.FLAG_MAPPED_TO_SYSTEM_VA);
            return 0;
        },
        // MmLockPagableDataSection(address) -> handle: nao existe paging de
        // imagem no jsOS (tudo residente) — a secao ja' esta travada de
        // fato; o handle nao-nulo registra o lock como no NT
        (address) => {
            lockedPagableSections.add(address >>> 0);
            return address;
        },
        // MmUnlockPagableImageSection(address)
        (address) => {
            lockedPagableSections.delete(address >>> 0);
            return 0;
        },
    ],
    registerRoutineLookup,
};
