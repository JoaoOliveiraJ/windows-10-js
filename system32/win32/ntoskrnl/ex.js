// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ex.js: exports Ex* (pool do convidado real).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const FastMutex = require('ntos/ke/fast-mutex');
const Resource = require('ntos/ex/resource');
const Lookaside = require('ntos/ex/lookaside');
const WorkItems = require('ntos/io/work-items');
const Irql = require('ntos/ke/irql');
const KeTimer = require('ntos/ke/timer');
const KeDpc = require('ntos/ke/dpc');

// ---- SLIST_HEADER x64 (wdm.h): Next @+0 (u64), Depth u16 @+8, Seq u16 @+0xA
function slistPush(slistHeadPointer, entryPointer) {
    const previousHead = GuestMemory.readGuest64(slistHeadPointer);
    GuestMemory.writeGuest64(entryPointer, previousHead);
    GuestMemory.writeGuest64(slistHeadPointer, entryPointer);
    GuestMemory.writeGuest16(slistHeadPointer + 8,
        GuestMemory.readGuest16(slistHeadPointer + 8) + 1);
    GuestMemory.writeGuest16(slistHeadPointer + 0xA,
        GuestMemory.readGuest16(slistHeadPointer + 0xA) + 1);
    return previousHead;
}
function slistPop(slistHeadPointer) {
    const head = GuestMemory.readGuest64(slistHeadPointer);
    if (!head) return 0;
    GuestMemory.writeGuest64(slistHeadPointer, GuestMemory.readGuest64(head));
    GuestMemory.writeGuest16(slistHeadPointer + 8,
        GuestMemory.readGuest16(slistHeadPointer + 8) - 1);
    return head;
}

// spinlock com subida de IRQL (padrao do ExAcquireSpinLock acima)
function lockWithRaise(spinLockPointer) {
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(Irql.DISPATCH_LEVEL);
    for (;;) {
        if (GuestMemory.readGuest32(spinLockPointer) === 0) {
            GuestMemory.writeGuest32(spinLockPointer, 1);
            return oldIrql;
        }
    }
}
function unlockWithLower(spinLockPointer, oldIrql) {
    GuestMemory.writeGuest32(spinLockPointer, 0);
    Irql.lowerIrql(oldIrql >>> 0);
}

// ---- RUNDOWN cache-aware: mesma semantica do EX_RUNDOWN_REF (Count no
// inicio: bit 0 = rundown ativo, referencias acima); "cache-aware" no NT e'
// uma otimizacao por processador — somos BSP-only, uma cache line basta
const CACHE_AWARE_RUNDOWN_SIZE = 64;

// ---- EX_TIMER: o timer moderno do NT (wdk 8+), embrulha KTIMER + KDPC.
// Nossa struct (0x100 bytes): +0x00 KTIMER, +0x40 KDPC, +0x80 callback,
// +0x88 context. O DPC e' interno (JS) e repassa (exTimer, context) ao
// callback do driver — assinatura PEXT_CALLBACK do WDK.
const EX_TIMER = { KTIMER: 0x00, KDPC: 0x40, CALLBACK: 0x80, CONTEXT: 0x88,
                   STRUCT_SIZE: 0x100 };

// gerador pseudo-aleatorio (xorshift32, bitwise JS e' 32 bits) semeado no TSC
let uuidGeneratorState = 0;
function nextRandom32() {
    if (!uuidGeneratorState)
        uuidGeneratorState = ((os.rdtsc() >>> 0) ^ 0x9E3779B9) || 0x2545F491;
    uuidGeneratorState ^= uuidGeneratorState << 13;
    uuidGeneratorState ^= uuidGeneratorState >>> 17;
    uuidGeneratorState ^= uuidGeneratorState << 5;
    return uuidGeneratorState >>> 0;
}
function nextRandom64() {
    return nextRandom32() + nextRandom32() * 0x100000000;
}

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
        'InitializeSListHead',
        'ExpInterlockedPushEntrySList',
        'ExpInterlockedPopEntrySList',
        'ExpInterlockedFlushSList',
        'ExQueryDepthSList',
        'ExInterlockedPushEntryList',
        'ExInterlockedPopEntryList',
        'ExInitializeNPagedLookasideList',
        'ExDeleteNPagedLookasideList',
        'ExSizeOfRundownProtectionCacheAware',
        'ExAllocateCacheAwareRundownProtection',
        'ExInitializeRundownProtectionCacheAware',
        'ExAcquireRundownProtectionCacheAware',
        'ExReleaseRundownProtectionCacheAware',
        'ExWaitForRundownProtectionReleaseCacheAware',
        'ExReInitializeRundownProtectionCacheAware',
        'ExFreeCacheAwareRundownProtection',
        'ExAllocateTimer',
        'ExSetTimer',
        'ExCancelTimer',
        'ExDeleteTimer',
        'ExUuidCreate',
        'EmClientQueryRuleState',        // Error Management: regra inexistente
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
        // ---- SLIST (single-CPU cooperativo: push/pop atomicos por construcao)
        // InitializeSListHead(slistHeadPtr): header de 16 bytes zerado
        (slistHeadPointer) => {
            GuestMemory.writeGuest64(slistHeadPointer, 0);
            GuestMemory.writeGuest64(slistHeadPointer + 8, 0);
            return 0;
        },
        // ExpInterlockedPushEntrySList(head, entry) -> cabeca anterior
        (slistHeadPointer, entryPointer) =>
            slistPush(slistHeadPointer, entryPointer),
        // ExpInterlockedPopEntrySList(head) -> entry ou 0
        (slistHeadPointer) => slistPop(slistHeadPointer),
        // ExpInterlockedFlushSList(head) -> a cadeia inteira; head fica vazia
        (slistHeadPointer) => {
            const head = GuestMemory.readGuest64(slistHeadPointer);
            GuestMemory.writeGuest64(slistHeadPointer, 0);
            GuestMemory.writeGuest16(slistHeadPointer + 8, 0);
            return head;
        },
        // ExQueryDepthSList(head) -> u16 Depth
        (slistHeadPointer) => GuestMemory.readGuest16(slistHeadPointer + 8),
        // ExInterlockedPushEntryList(head, entry, lock): push com o spinlock
        (listHeadPointer, entryPointer, spinLockPointer) => {
            const oldIrql = lockWithRaise(spinLockPointer);
            const previous = slistPush(listHeadPointer, entryPointer);
            unlockWithLower(spinLockPointer, oldIrql);
            return previous;
        },
        // ExInterlockedPopEntryList(head, lock)
        (listHeadPointer, spinLockPointer) => {
            const oldIrql = lockWithRaise(spinLockPointer);
            const entry = slistPop(listHeadPointer);
            unlockWithLower(spinLockPointer, oldIrql);
            return entry;
        },
        // ExInitializeNPagedLookasideList(...): mesmo motor do paged — nosso
        // pool do convidado e' unico e nao-paginavel (ver lookaside.js)
        (listPointer, _allocRoutine, _freeRoutine, _flags, blockSize, tag,
         depth) => Lookaside.initialize(listPointer, blockSize, tag, depth),
        // ExDeleteNPagedLookasideList(listPtr)
        (listPointer) => Lookaside.deleteList(listPointer),
        // ExSizeOfRundownProtectionCacheAware() -> tamanho da struct (1 linha
        // de cache — o NT aloca por processador; somos BSP-only)
        () => CACHE_AWARE_RUNDOWN_SIZE,
        // ExAllocateCacheAwareRundownProtection() -> struct inicializada ou 0
        () => {
            const pointer = GuestMemory.guestAllocBytes(CACHE_AWARE_RUNDOWN_SIZE);
            return pointer;
        },
        // ExInitializeRundownProtectionCacheAware(ptr, size): Count = 0
        (rundownPointer, _size) => {
            GuestMemory.writeGuest32(rundownPointer, 0);
            GuestMemory.writeGuest32(rundownPointer + 4, 0);
            return 0;
        },
        // ExAcquireRundownProtectionCacheAware(ptr) -> BOOLEAN
        (rundownPointer) => {
            const count = GuestMemory.readGuest32(rundownPointer) >>> 0;
            if (count & 1) return 0;
            GuestMemory.writeGuest32(rundownPointer, (count + 2) >>> 0);
            return 1;
        },
        // ExReleaseRundownProtectionCacheAware(ptr)
        (rundownPointer) => {
            const count = GuestMemory.readGuest32(rundownPointer) >>> 0;
            GuestMemory.writeGuest32(rundownPointer, (count - 2) >>> 0);
            return 0;
        },
        // ExWaitForRundownProtectionReleaseCacheAware(ptr): espera as refs
        // zerarem (ficar so o bit de rundown). Modelo cooperativo: bombeia o
        // kernel (timers/DPCs/work items) entre as leituras — quem segura a
        // ref completa nesse caminho, como o NT ao cair de DISPATCH
        (rundownPointer) => {
            for (;;) {
                const count = GuestMemory.readGuest32(rundownPointer) >>> 0;
                if ((count & ~1) === 0) return 0;
                KeTimer.checkTimers();
                KeDpc.runQueue();
                WorkItems.runQueue();
            }
        },
        // ExReInitializeRundownProtectionCacheAware(ptr): volta a admitir refs
        (rundownPointer) => {
            GuestMemory.writeGuest32(rundownPointer, 0);
            return 0;
        },
        // ExFreeCacheAwareRundownProtection(ptr)
        (rundownPointer) => { GuestMemory.guestFreeBytes(rundownPointer); return 0; },
        // ExAllocateTimer(callback, context, attributes) -> EX_TIMER* ou 0
        (callbackPointer, contextPointer, _attributes) => {
            const timerPointer = GuestMemory.guestAllocBytes(EX_TIMER.STRUCT_SIZE);
            if (!timerPointer) return 0;
            KeTimer.initializeTimer(timerPointer + EX_TIMER.KTIMER, 0);
            GuestMemory.writeGuest64(timerPointer + EX_TIMER.CALLBACK,
                                     callbackPointer);
            GuestMemory.writeGuest64(timerPointer + EX_TIMER.CONTEXT,
                                     contextPointer);
            KeDpc.initializeJsDpc(timerPointer + EX_TIMER.KDPC,
                (dpcPointer) => {
                    const exTimerPointer = dpcPointer - EX_TIMER.KDPC;
                    const callback = GuestMemory.readGuest64(
                        exTimerPointer + EX_TIMER.CALLBACK);
                    const context = GuestMemory.readGuest64(
                        exTimerPointer + EX_TIMER.CONTEXT);
                    os.execMsAbi(callback, exTimerPointer, context);
                }, 0);
            return timerPointer;
        },
        // ExSetTimer(exTimer, dueTime u64, periodMs, parametersPtr) -> BOOLEAN
        (timerPointer, dueTime, periodMs, parametersPointer) => {
            let effectivePeriod = periodMs;
            if (parametersPointer) {
                const parameterPeriod = GuestMemory.readGuest32(parametersPointer);
                if (parameterPeriod) effectivePeriod = parameterPeriod;
            }
            return KeTimer.setTimer(timerPointer + EX_TIMER.KTIMER, dueTime,
                                    timerPointer + EX_TIMER.KDPC,
                                    effectivePeriod) ? 1 : 0;
        },
        // ExCancelTimer(exTimer) -> BOOLEAN (estava na fila)
        (timerPointer) =>
            KeTimer.cancelTimer(timerPointer + EX_TIMER.KTIMER) ? 1 : 0,
        // ExDeleteTimer(exTimer, cancel, wait, parameters) -> BOOLEAN
        (timerPointer, cancel, _wait, _parameters) => {
            const wasQueued = cancel ?
                (KeTimer.cancelTimer(timerPointer + EX_TIMER.KTIMER) ? 1 : 0) : 0;
            GuestMemory.guestFreeBytes(timerPointer);
            return wasQueued;
        },
        // ExUuidCreate(outUuidPtr): UUID v4 de verdade (RFC 4122): 122 bits
        // aleatorios + versao 4 + variante DCE
        (uuidPointer) => {
            const randomLow = nextRandom64();
            const randomHigh = nextRandom64();
            GuestMemory.writeGuest64(uuidPointer, randomLow);
            GuestMemory.writeGuest64(uuidPointer + 8, randomHigh);
            const byte6 = GuestMemory.readGuest8(uuidPointer + 6);
            GuestMemory.writeGuest8(uuidPointer + 6, (byte6 & 0x0F) | 0x40);
            const byte8 = GuestMemory.readGuest8(uuidPointer + 8);
            GuestMemory.writeGuest8(uuidPointer + 8, (byte8 & 0x3F) | 0x80);
            return 0;   // STATUS_SUCCESS
        },
        // EmClientQueryRuleState(...): o banco de regras de Error Management
        // (WER kernel) esta vazio — a resposta REAL do NT para uma regra que
        // nao existe e' STATUS_NOT_FOUND (o ataport trata e segue o default)
        () => 0xC0000225 | 0,   // STATUS_NOT_FOUND
    ],
};
