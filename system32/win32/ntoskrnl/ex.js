// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ex.js: exports Ex* (pool do convidado real).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const FastMutex = require('ntos/ke/fast-mutex');
const Resource = require('ntos/ex/resource');
const Lookaside = require('ntos/ex/lookaside');
const WorkItems = require('ntos/io/work-items');
const Irql = require('ntos/ke/irql');

module.exports = {
    names: [
        'ExAllocatePoolWithTag',
        'ExFreePool',
        'ExFreePoolWithTag',   // WDK real: ExFreePool e macro p/ esta
        'ExAllocatePool2',     // (POOL_FLAGS u64, size, tag) — WDK moderno
        'ExAllocatePoolZero',  // (POOL_FLAGS u64, size, tag) — idem zerado
        'ExAllocatePoolUninitialized',
        'ExFreePool2',         // (pointer, tag) — WDK moderno
        'ExInitializeFastMutex',
        'ExAcquireFastMutex',
        'ExTryToAcquireFastMutex',
        'ExReleaseFastMutex',
        'ExInitializeResourceLite',
        'ExAcquireResourceExclusiveLite',
        'ExAcquireResourceSharedLite',
        'ExReleaseResourceLite',
        'ExIsResourceAcquiredExclusiveLite',
        'ExIsResourceAcquiredSharedLite',
        'ExConvertExclusiveToSharedLite',
        'ExDeleteResourceLite',
        'ExAcquireSharedStarveExclusive',
        'ExAcquireSharedWaitForExclusive',
        'ExInitializeRundownProtection',
        'ExAcquireRundownProtection',
        'ExReleaseRundownProtection',
        'ExRundownCompleted',
        'ExInitializePagedLookasideList',
        'ExAllocateFromPagedLookasideList',
        'ExFreeToPagedLookasideList',
        'ExDeletePagedLookasideList',
        'ExGetPreviousMode',
        'ExInitializeWorkItem',           // (itemPtr, routinePtr, contextPtr)
        'ExQueueWorkItem',                // (itemPtr, queueType)
        'ExAcquireSpinLock',              // (lockPtr, outOldIrqlPtr) legado
        'ExReleaseSpinLock',              // (lockPtr, oldIrql)
        'ExAcquireFastMutexUnsafe',       // chamador ja esta em contexto APC
        'ExReleaseFastMutexUnsafe',
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
        // ExInitializeFastMutex(fastMutexPtr)
        (fastMutexPointer) => {
            FastMutex.initialize(fastMutexPointer);
            return 0;
        },
        // ExAcquireFastMutex(fastMutexPtr)
        (fastMutexPointer) => { FastMutex.acquire(fastMutexPointer); return 0; },
        // ExTryToAcquireFastMutex(fastMutexPtr) -> 1 se tomou
        (fastMutexPointer) => FastMutex.tryAcquire(fastMutexPointer),
        // ExReleaseFastMutex(fastMutexPtr)
        (fastMutexPointer) => { FastMutex.release(fastMutexPointer); return 0; },
        // ERESOURCE (reader/writer lock — ntos/ex/resource.js)
        (resourcePointer) => Resource.initialize(resourcePointer),
        (resourcePointer, wait) => Resource.acquireExclusive(resourcePointer, wait),
        (resourcePointer, wait) => Resource.acquireShared(resourcePointer, wait),
        (resourcePointer) => Resource.release(resourcePointer),
        (resourcePointer) => Resource.isAcquiredExclusive(resourcePointer),
        (resourcePointer) => Resource.isAcquiredShared(resourcePointer),
        (resourcePointer) => Resource.convertExclusiveToShared(resourcePointer),
        (resourcePointer) => Resource.deleteResource(resourcePointer),
        // ExAcquireSharedStarveExclusive(resourcePtr, wait)
        (resourcePointer, wait) =>
            Resource.acquireSharedStarveExclusive(resourcePointer, wait),
        // ExAcquireSharedWaitForExclusive(resourcePtr, wait)
        (resourcePointer, wait) =>
            Resource.acquireSharedWaitForExclusive(resourcePointer, wait),
        // RUNDOWN_REFERENCE: Count real do NT — bit 0 = rundown ativo,
        // referencias nos bits acima (<<1)
        (rundownPointer) => {   // ExInitializeRundownProtection
            GuestMemory.writeGuest32(rundownPointer, 0);
            GuestMemory.writeGuest32(rundownPointer + 4, 0);
            return 0;
        },
        (rundownPointer) => {   // ExAcquireRundownProtection -> BOOLEAN
            const count = GuestMemory.readGuest32(rundownPointer) >>> 0;
            if (count & 1) return 0;            // rundown ativo: recusa
            GuestMemory.writeGuest32(rundownPointer, (count + 2) >>> 0);
            return 1;
        },
        (rundownPointer) => {   // ExReleaseRundownProtection
            const count = GuestMemory.readGuest32(rundownPointer) >>> 0;
            GuestMemory.writeGuest32(rundownPointer, (count - 2) >>> 0);
            return 0;
        },
        (rundownPointer) => {   // ExRundownCompleted: liga o bit de rundown
            const count = GuestMemory.readGuest32(rundownPointer) >>> 0;
            GuestMemory.writeGuest32(rundownPointer, (count | 1) >>> 0);
            return 0;
        },
        // ExInitializePagedLookasideList(list, alloc, free, flags, size, tag, depth)
        (listPointer, _allocRoutine, _freeRoutine, _flags, blockSize, tag,
         depth) => Lookaside.initialize(listPointer, blockSize, tag, depth),
        // ExAllocateFromPagedLookasideList(listPtr)
        (listPointer) => Lookaside.allocate(listPointer),
        // ExFreeToPagedLookasideList(listPtr, blockPtr)
        (listPointer, blockPointer) => Lookaside.free(listPointer, blockPointer),
        // ExDeletePagedLookasideList(listPtr)
        (listPointer) => Lookaside.deleteList(listPointer),
        // ExGetPreviousMode() -> KernelMode (0): nossos drivers rodam em kernel
        () => 0,
        // ExInitializeWorkItem(itemPtr, routinePtr, contextPtr): WORK_QUEUE_ITEM
        // — a routine recebe so o contexto (modelo Ex, 1 arg)
        (itemPointer, routinePointer, contextPointer) => {
            WorkItems.initializeExWorkItem(itemPointer, routinePointer,
                                           contextPointer);
            return 0;
        },
        // ExQueueWorkItem(itemPtr, queueType)
        (itemPointer, queueType) => {
            WorkItems.queueExWorkItem(itemPointer, queueType);
            return 0;
        },
        // ExAcquireSpinLock(lockPtr, outOldIrqlPtr): a API legada do NT —
        // sobe a DISPATCH_LEVEL e adquire com test-and-set
        (spinLockPointer, outOldIrqlPointer) => {
            const oldIrql = Irql.getIrql();
            Irql.raiseIrql(Irql.DISPATCH_LEVEL);
            for (;;) {
                if (GuestMemory.readGuest32(spinLockPointer) === 0) {
                    GuestMemory.writeGuest32(spinLockPointer, 1);
                    break;
                }
            }
            GuestMemory.writeGuest32(outOldIrqlPointer, oldIrql);
            return 0;
        },
        // ExReleaseSpinLock(lockPtr, oldIrql)
        (spinLockPointer, oldIrql) => {
            GuestMemory.writeGuest32(spinLockPointer, 0);
            Irql.lowerIrql(oldIrql >>> 0);
            return 0;
        },
        // ExAcquireFastMutexUnsafe(fastMutexPtr): variante que NAO desliga
        // APCs (o chamador garante o contexto) — mesma aquisicao real
        (fastMutexPointer) => { FastMutex.acquire(fastMutexPointer); return 0; },
        // ExReleaseFastMutexUnsafe(fastMutexPtr)
        (fastMutexPointer) => { FastMutex.release(fastMutexPointer); return 0; },
    ],
};
