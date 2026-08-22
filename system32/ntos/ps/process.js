// ===========================================================================
// jsOS - system32/ntos/ps/process.js: Process Manager com o MESMO modelo do
// NT, conferido por disassembly do ntoskrnl.exe real (Win10 22H2):
//
//   IoGetCurrentProcess:  mov rax, gs:[0x188]  ; Prcb.CurrentThread (KTHREAD)
//                         mov rax, [rax+0xB8]  ; KTHREAD.ApcState.Process
//   PsGetProcessId:       mov rax, [rcx+0x440] ; EPROCESS.UniqueProcessId
//
// Aqui: cada processo tem um EPROCESS real (offsets oficiais — pid @0x440,
// ActiveProcessLinks @0x448, ImageFileName @0x5a8...) e cada thread um
// KTHREAD real com ApcState.Process @0xB8 e Cid @0x478/0x480. O "registrador
// de thread corrente" (que no NT e' gs:[0x188]) e' mantido pelo escalonador
// em JS — IoGetCurrentProcess faz o mesmo caminho: thread corrente ->
// ApcState.Process. PsActiveProcessHead e' uma LIST_ENTRY circular real.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');
const Clock = require('ntos/ke/clock');
const MemoryMap = require('ntos/mm/memory-map');

const EPROCESS = NtAbi.EPROCESS;
const KTHREAD = NtAbi.KTHREAD;

const SYSTEM_PROCESS_ID = 4;          // pid 4 = System (como o NT)

let psActiveProcessHead = 0;          // sentinel da LIST_ENTRY global
let systemProcessPointer = 0;
let currentThreadPointer = 0;         // o "gs:[0x188]" do jsOS

// CREATE_PROCESS_NOTIFY routines registradas por drivers (PsSetCreate*):
// void callback(HANDLE parentPid, HANDLE pid, BOOLEAN created)
const processNotifyRoutines = [];

function registerProcessNotify(callbackPointer) {
    processNotifyRoutines.push(callbackPointer >>> 0);
}
function unregisterProcessNotify(callbackPointer) {
    const index = processNotifyRoutines.indexOf(callbackPointer >>> 0);
    if (index >= 0) processNotifyRoutines.splice(index, 1);
    return index >= 0;
}

// dispara as notificacoes (parent = processo corrente, como o NT)
function fireProcessNotify(processId, created) {
    const parentPid = getCurrentProcessId();
    for (const callbackPointer of processNotifyRoutines)
        os.execMsAbi(callbackPointer, parentPid, processId, created ? 1 : 0);
}

function read64(address) { return GuestMemory.readGuest64(address); }
function write64(address, value) { GuestMemory.writeGuest64(address, value); }
function write32(address, value) { GuestMemory.writeGuest32(address, value >>> 0); }

// insere na cadeia circular PsActiveProcessHead (LIST_ENTRY Flink/Blink real)
function insertIntoActiveProcessList(processPointer) {
    const links = processPointer + EPROCESS.ACTIVE_PROCESS_LINKS;
    const lastProcess = read64(psActiveProcessHead + 8);   // Blink do sentinel
    write64(links, psActiveProcessHead);                   // Flink = sentinel
    write64(links + 8, lastProcess);                       // Blink = ultimo
    write64(lastProcess, links);                           // ultimo->Flink = eu
    write64(psActiveProcessHead + 8, links);               // sentinel->Blink = eu
}

function removeFromActiveProcessList(processPointer) {
    const links = processPointer + EPROCESS.ACTIVE_PROCESS_LINKS;
    const next = read64(links);
    const previous = read64(links + 8);
    write64(previous, next);
    write64(next + 8, previous);
}

// cria um EPROCESS real (0xA00 bytes) com os campos oficiais preenchidos
function createProcess(processId, imageName) {
    const processPointer = GuestMemory.guestAllocBytes(EPROCESS.SIZE);
    // KPROCESS embutido: tipo + DirectoryTableBase (CR3 real do sistema)
    write32(processPointer, EPROCESS.TYPE_PROCESS);
    write64(processPointer + EPROCESS.DIRECTORY_TABLE_BASE,
            MemoryMap.PML4_PHYS);
    write64(processPointer + EPROCESS.UNIQUE_PROCESS_ID, processId);
    write64(processPointer + EPROCESS.CREATE_TIME, Math.floor(Clock.uptimeMs()));
    write32(processPointer + EPROCESS.ACTIVE_THREADS, 1);
    const shortName = String(imageName).slice(0, 15);
    for (let i = 0; i < 15; i++)
        GuestMemory.writeGuest8(processPointer + EPROCESS.IMAGE_FILE_NAME + i,
                                i < shortName.length ? shortName.charCodeAt(i) : 0);
    insertIntoActiveProcessList(processPointer);
    fireProcessNotify(processId, true);    // PsSetCreateProcessNotifyRoutine
    return processPointer;
}

// cria um KTHREAD real ligado ao processo (ApcState.Process + Cid)
function createKernelThread(processPointer, threadId) {
    const threadPointer = GuestMemory.guestAllocBytes(KTHREAD.SIZE);
    const processId = read64(processPointer + EPROCESS.UNIQUE_PROCESS_ID);
    write64(threadPointer + KTHREAD.APC_STATE_PROCESS, processPointer);
    write64(threadPointer + KTHREAD.CID_UNIQUE_PROCESS, processId);
    write64(threadPointer + KTHREAD.CID_UNIQUE_THREAD, threadId);
    return threadPointer;
}

function terminateProcess(processPointer) {
    const processId = read64(processPointer + EPROCESS.UNIQUE_PROCESS_ID);
    fireProcessNotify(processId, false);   // notificacao de saida (Create=FALSE)
    write32(processPointer + EPROCESS.ACTIVE_THREADS, 0);
    write64(processPointer + EPROCESS.EXIT_TIME, Math.floor(Clock.uptimeMs()));
    removeFromActiveProcessList(processPointer);
}

// contagem de threads do processo (EPROCESS.ActiveThreads real)
function addThread(processPointer) {
    const active = GuestMemory.readGuest32(processPointer + EPROCESS.ACTIVE_THREADS);
    write32(processPointer + EPROCESS.ACTIVE_THREADS, active + 1);
}
function removeThread(processPointer) {
    const active = GuestMemory.readGuest32(processPointer + EPROCESS.ACTIVE_THREADS);
    if (active > 0)
        write32(processPointer + EPROCESS.ACTIVE_THREADS, active - 1);
}

// ---- o "registrador de thread corrente" (gs:[0x188] do NT) ----------------
function setCurrentThread(threadPointer) { currentThreadPointer = threadPointer; }
function getCurrentThread() { return currentThreadPointer; }

// IoGetCurrentProcess/PsGetCurrentProcess: MESMO algoritmo do NT
function getCurrentProcess() {
    if (!currentThreadPointer) return systemProcessPointer;
    return read64(currentThreadPointer + KTHREAD.APC_STATE_PROCESS);
}

// PsGetCurrentProcessId / PsGetCurrentThreadId (algoritmo do NT)
function getCurrentProcessId() {
    if (!currentThreadPointer) return SYSTEM_PROCESS_ID;
    return read64(currentThreadPointer + KTHREAD.CID_UNIQUE_PROCESS);
}
function getCurrentThreadId() {
    if (!currentThreadPointer) return 0;
    return read64(currentThreadPointer + KTHREAD.CID_UNIQUE_THREAD);
}

// caminha PsActiveProcessHead (enumeracao de processos como o WinDbg !process)
function listActiveProcesses() {
    const result = [];
    let cursor = read64(psActiveProcessHead);   // Flink do sentinel
    while (cursor && cursor !== psActiveProcessHead) {
        const processPointer = cursor - EPROCESS.ACTIVE_PROCESS_LINKS;
        let name = '';
        for (let i = 0; i < 15; i++) {
            const c = GuestMemory.readGuest8(processPointer +
                                             EPROCESS.IMAGE_FILE_NAME + i);
            if (!c) break;
            name += String.fromCharCode(c);
        }
        result.push({
            pid: read64(processPointer + EPROCESS.UNIQUE_PROCESS_ID),
            name,
            address: processPointer,
        });
        cursor = read64(cursor);
    }
    return result;
}

function init() {
    psActiveProcessHead = GuestMemory.guestAllocBytes(16);
    write64(psActiveProcessHead, psActiveProcessHead);
    write64(psActiveProcessHead + 8, psActiveProcessHead);
    systemProcessPointer = createProcess(SYSTEM_PROCESS_ID, 'System');
}

module.exports = { init, createProcess, createKernelThread, terminateProcess,
                   addThread, removeThread,
                   setCurrentThread, getCurrentThread, getCurrentProcess,
                   getCurrentProcessId, getCurrentThreadId, listActiveProcesses,
                   registerProcessNotify, unregisterProcessNotify,
                   getSystemProcess: () => systemProcessPointer,
                   SYSTEM_PROCESS_ID };
