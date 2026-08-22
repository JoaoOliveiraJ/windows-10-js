// ===========================================================================
// jsOS - system32/win32/ntoskrnl/mm.js: exports Mm* (memoria do convidado
// real, via a arena gerenciada em win32/guest-memory.js).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const Paging = require('ntos/mm/paging');

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
            if (apiId < 0) return 0;
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
    ],
    registerRoutineLookup,
};
