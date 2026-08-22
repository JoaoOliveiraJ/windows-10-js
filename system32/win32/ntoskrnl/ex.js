// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ex.js: exports Ex* (pool do convidado real).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

module.exports = {
    names: [
        'ExAllocatePoolWithTag',
        'ExFreePool',
        'ExFreePoolWithTag',   // WDK real: ExFreePool e macro p/ esta
        'ExAllocatePool2',     // (POOL_FLAGS u64, size, tag) — WDK moderno
        'ExAllocatePoolZero',  // (POOL_FLAGS u64, size, tag) — idem zerado
        'ExAllocatePoolUninitialized',
        'ExFreePool2',         // (pointer, tag) — WDK moderno
    ],
    handlers: [
        // ExAllocatePoolWithTag(poolType, size, tag) -> memoria zerada
        (_poolType, size, _tag) => GuestMemory.guestAllocBytes(size),
        // ExFreePool(pointer)
        (pointer) => { GuestMemory.guestFreeBytes(pointer); return 0; },
        // ExFreePoolWithTag(pointer, tag)
        (pointer, _tag) => { GuestMemory.guestFreeBytes(pointer); return 0; },
        // ExAllocatePool2(flags u64, size, tag): POOL_FLAGS so escolhe
        // paged/nonpagado — nosso pool do convidado e' unico (nao-paginavel)
        (_poolFlags, size, _tag) => GuestMemory.guestAllocBytes(size),
        // ExAllocatePoolZero(flags u64, size, tag)
        (_poolFlags, size, _tag) => GuestMemory.guestAllocBytes(size),
        // ExAllocatePoolUninitialized(flags u64, size, tag): nao zera — usa o
        // alocador direto sem a garantia de zero (guestAllocRaw)
        (_poolFlags, size, _tag) => GuestMemory.guestAllocRaw(size),
        // ExFreePool2(pointer, tag)
        (pointer, _tag) => { GuestMemory.guestFreeBytes(pointer); return 0; },
    ],
};
