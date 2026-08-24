// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ps.js: exports Ps* (threads de kernel em
// ntos/ps/kernel-threads.js, sobre o escalonador cooperativo).
// ===========================================================================

const KernelThreads = require('ntos/ps/kernel-threads');
const Process = require('ntos/ps/process');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

// ---- server silos (containers do NT) --------------------------------------
// Sem jobs/containers no jsOS: o HOST silo existe e e' unico (a resposta
// real de um Windows sem server silos); jobs nao tem silo (NULL). Os silo
// context slots sao REAIS: uma tabela por silo (o mountmgr guarda seu
// estado global la, como faz no NT).
let hostSiloPointer = 0;
function hostSilo() {
    if (!hostSiloPointer) hostSiloPointer = GuestMemory.guestAllocBytes(0x40);
    return hostSiloPointer;
}

// tabelas de context slots: siloPtr -> Map(slotIndex -> { contextPointer,
// size, tag }); contextPtr -> { refs, tag } (refcount real)
const siloTablesBySilo = new Map();
const siloContexts = new Map();
const slotOwnerByIndex = new Map();   // slotIndex -> siloPtr
let nextSiloContextSlot = 1;

// o silo "atachado" da thread atual (PsAttach/DetachSiloToCurrentThread)
let currentThreadSiloPointer = 0;

function siloTable(siloPointer) {
    const key = siloPointer >>> 0;
    let table = siloTablesBySilo.get(key);
    if (!table) { table = new Map(); siloTablesBySilo.set(key, table); }
    return table;
}

// PsJobType: a variavel global POBJECT_TYPE do tipo Job
let jobTypeVariable = 0;
function jobType() {
    if (!jobTypeVariable) {
        const typeStruct = GuestMemory.guestAllocBytes(0x40);
        jobTypeVariable = GuestMemory.guestAllocBytes(8);
        GuestMemory.writeGuest64(jobTypeVariable, typeStruct);
    }
    return jobTypeVariable;
}

// hard errors desabilitados por thread (single-thread do sistema: um campo)
let threadHardErrorsDisabled = 0;

module.exports = {
    names: [
        'PsCreateSystemThread',
        'PsTerminateSystemThread',
        'PsGetCurrentThreadId',     // () -> KTHREAD.Cid.UniqueThread (caminho do NT)
        'PsGetCurrentProcessId',    // () -> KTHREAD.Cid.UniqueProcess (idem)
        'PsSetCreateProcessNotifyRoutine',      // (callbackPtr, remove)
        'PsRemoveCreateProcessNotifyRoutine',   // (callbackPtr)
        'PsLookupProcessByProcessId',           // (pid, outProcessPtr)
        'PsGetProcessId',                       // (processPtr) -> pid @0x440 (RE)
        'PsGetJobSilo',                         // (job) -> NULL (sem silos)
        'PsGetHostSilo',                        // () -> o host silo unico
        'PsIsHostSilo',                         // (silo) -> BOOLEAN
        'PsGetThreadHardErrorsAreDisabled',     // () -> BOOLEAN
        'PsSetThreadHardErrorsAreDisabled',     // (disabled) -> anterior
        'PsAllocSiloContextSlot',               // (silo, size, tag, outSlot)
        'PsCreateSiloContext',                  // (silo, size, tag, outCtx)
        'PsInsertPermanentSiloContext',         // (silo, slot, ctx)
        'PsDereferenceSiloContext',             // (ctx)
        'PsFreeSiloContextSlot',                // (slot)
        'PsAttachSiloToCurrentThread',          // (silo) -> anterior
        'PsDetachSiloFromCurrentThread',        // (silo)
    ],
    handlers: [
        // PsCreateSystemThread(outHandlePtr, access, objAttrs, procHandle,
        //                      clientId, startRoutinePtr, contextPtr)
        (outHandlePointer, _access, _objectAttributes, _processHandle, _clientId,
         startRoutinePointer, contextPointer) => {
            KernelThreads.createSystemThread(outHandlePointer, startRoutinePointer,
                                             contextPointer);
            return 0;
        },
        // PsTerminateSystemThread(status)
        (_status) => KernelThreads.terminateCurrentThread(),
        // PsGetCurrentThreadId(): thread corrente -> Cid.UniqueThread
        () => Process.getCurrentThreadId(),
        // PsGetCurrentProcessId(): thread corrente -> Cid.UniqueProcess
        () => Process.getCurrentProcessId(),
        // PsSetCreateProcessNotifyRoutine(callbackPtr, remove=FALSE) — registra
        (callbackPointer, remove) => {
            if (remove & 0xFF)
                return Process.unregisterProcessNotify(callbackPointer)
                    ? 0 : 0xC000007A | 0;   // STATUS_PROCEDURE_NOT_FOUND
            Process.registerProcessNotify(callbackPointer);
            return 0;
        },
        // PsRemoveCreateProcessNotifyRoutine(callbackPtr)
        (callbackPointer) =>
            Process.unregisterProcessNotify(callbackPointer)
                ? 0 : 0xC000007A | 0,
        // PsLookupProcessByProcessId(pid, outProcessPtr): anda a cadeia
        // PsActiveProcessHead procurando o pid (como o NT)
        (processId, outputPointer) => {
            const found = Process.listActiveProcesses()
                .find(p => p.pid === (processId >>> 0) ||
                           p.pid === processId);
            if (!found) return 0xC0000074 | 0;   // STATUS_NOT_FOUND... invalid pid
            GuestMemory.writeGuest64(outputPointer, found.address);
            return 0;
        },
        // PsGetProcessId(processPtr) -> EPROCESS.UniqueProcessId (@0x440, RE)
        (processPointer) =>
            GuestMemory.readGuest64(processPointer +
                                    NtAbi.EPROCESS.UNIQUE_PROCESS_ID),
        // PsGetJobSilo(jobPtr) -> NULL: nao existem jobs com silo (a resposta
        // real de um Windows sem server silos/containers)
        (_jobPointer) => 0,
        // PsGetHostSilo() -> o silo hospedeiro (unico, persistente)
        () => hostSilo(),
        // PsIsHostSilo(siloPtr) -> BOOLEAN
        (siloPointer) => (siloPointer >>> 0) === (hostSilo() >>> 0) ? 1 : 0,
        // PsGetThreadHardErrorsAreDisabled() -> flag do thread atual (default
        // do NT: hard errors HABILITADOS = 0)
        () => threadHardErrorsDisabled,
        // PsSetThreadHardErrorsAreDisabled(disabled) -> valor anterior
        (disabled) => {
            const previous = threadHardErrorsDisabled;
            threadHardErrorsDisabled = disabled ? 1 : 0;
            return previous;
        },
        // PsAllocSiloContextSlot(reserved, outSlotPtr): assinatura REAL do
        // ntddk.h — 2 args (Reserved ignorado, devolve o indice do slot)
        (_reserved, outSlotPointer) => {
            const slotIndex = nextSiloContextSlot++;
            siloTable(hostSilo()).set(slotIndex, {
                contextPointer: 0, permanent: false });
            slotOwnerByIndex.set(slotIndex, hostSilo() >>> 0);
            GuestMemory.writeGuest32(outSlotPointer, slotIndex);
            return 0;
        },
        // PsCreateSiloContext(silo, size, poolType, cleanupCallback,
        // outContextPtr): 5 args (ntddk.h) — o cleanup callback e' guardado
        // e roda quando o refcount chega a zero (semantica real)
        (siloPointer, size, _poolType, cleanupCallback, outContextPointer) => {
            const contextPointer = GuestMemory.guestAllocBytes(size >>> 0);
            if (!contextPointer) return 0xC000009A | 0;
            siloContexts.set(contextPointer >>> 0,
                { refs: 1, cleanupCallback: cleanupCallback >>> 0,
                  siloPointer: siloPointer >>> 0 });
            GuestMemory.writeGuest64(outContextPointer, contextPointer);
            return 0;
        },
        // PsInsertPermanentSiloContext(silo, slot, context): insere o
        // contexto no slot (permanente — o NT nao deixa remover depois)
        (siloPointer, slotIndex, contextPointer) => {
            const entry = siloTable(siloPointer).get(slotIndex >>> 0);
            if (!entry) return 0xC0000225 | 0;   // STATUS_NOT_FOUND
            entry.contextPointer = contextPointer >>> 0;
            entry.permanent = true;
            return 0;
        },
        // PsDereferenceSiloContext(context): refcount real; no zero roda o
        // cleanup callback registrado e libera (semantica do NT)
        (contextPointer) => {
            const record = siloContexts.get(contextPointer >>> 0);
            if (!record) return 0;
            record.refs--;
            if (record.refs <= 0) {
                siloContexts.delete(contextPointer >>> 0);
                if (record.cleanupCallback)
                    os.execMsAbi(record.cleanupCallback, contextPointer);
                GuestMemory.guestFreeBytes(contextPointer);
            }
            return 0;
        },
        // PsFreeSiloContextSlot(slot): devolve o slot (remove da tabela dona)
        (slotIndex) => {
            const owner = slotOwnerByIndex.get(slotIndex >>> 0);
            if (owner === undefined) return 0;
            const table = siloTablesBySilo.get(owner);
            if (table) table.delete(slotIndex >>> 0);
            slotOwnerByIndex.delete(slotIndex >>> 0);
            return 0;
        },
        // PsAttachSiloToCurrentThread(silo) -> silo anterior: troca o silo da
        // thread (real — o estado e' por thread; somos single-thread de
        // sistema, entao um campo global honesto)
        (siloPointer) => {
            const previous = currentThreadSiloPointer || hostSilo();
            currentThreadSiloPointer = siloPointer >>> 0;
            return previous;
        },
        // PsDetachSiloFromCurrentThread(silo): volta ao silo anterior (host)
        (_siloPointer) => {
            currentThreadSiloPointer = hostSilo();
            return 0;
        },
    ],
    // exports de DADO: PsJobType e' a variavel global POBJECT_TYPE do Job
    dataExports: {
        PsJobType: () => jobType(),
    },
};
