// ===========================================================================
// jsOS - system32/win32/ntoskrnl/mm.js: exports Mm* (memoria do convidado
// real, via a arena gerenciada em win32/guest-memory.js).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

module.exports = {
    names: [
        'MmAllocateNonCachedMemory',
        'MmFreeNonCachedMemory',
    ],
    handlers: [
        // MmAllocateNonCachedMemory(size) -> memoria fisica zerada
        (size) => GuestMemory.guestAllocBytes(size),
        // MmFreeNonCachedMemory(pointer, size)
        (pointer, _size) => { GuestMemory.guestFreeBytes(pointer); return 0; },
    ],
};
