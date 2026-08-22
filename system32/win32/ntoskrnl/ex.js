// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ex.js: exports Ex* (pool do convidado real).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

module.exports = {
    names: [
        'ExAllocatePoolWithTag',
        'ExFreePool',
        'ExFreePoolWithTag',   // WDK real: ExFreePool e macro p/ esta
    ],
    handlers: [
        // ExAllocatePoolWithTag(poolType, size, tag) -> memoria zerada
        (_poolType, size, _tag) => GuestMemory.guestAllocBytes(size),
        // ExFreePool(pointer)
        (pointer) => { GuestMemory.guestFreeBytes(pointer); return 0; },
        // ExFreePoolWithTag(pointer, tag)
        (pointer, _tag) => { GuestMemory.guestFreeBytes(pointer); return 0; },
    ],
};
