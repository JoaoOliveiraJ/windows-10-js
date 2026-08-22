// ===========================================================================
// jsOS - system32/ntos/ps/scheduler.js: escalonador cooperativo round-robin.
//
// Um processo e uma funcao geradora JS: cada `yield` devolve o controle ao
// kernel; o proximo processo READY roda um passo. Estados:
// ready -> running -> done/killed (reaped pelo kernel).
//
// Cada processo tem um EPROCESS + KTHREAD reais (ntos/ps/process.js); o tick
// ajusta a "thread corrente" (o gs:[0x188] do NT) durante o passo de cada um.
// ===========================================================================

const Process = require('ntos/ps/process');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const procs = [];
let nextPid = 8;          // 0-7 reservados (4 = System, como o NT)
let systemThreadPointer = 0;

function spawn(name, genFn, ...args) {
    const pid = nextPid++;
    const processPointer = Process.createProcess(pid, name);
    const threadPointer = Process.createKernelThread(processPointer, pid * 4);
    const p = { pid, name, gen: genFn(...args), state: 'ready',
                processPointer, threadPointer, ownsProcess: true };
    procs.push(p);
    return p.pid;
}

// thread de kernel: roda DENTRO de um processo existente (System p/ drivers,
// como o NT) — sem EPROCESS novo; o KTHREAD ja foi criado pelo caller
function spawnIntoProcess(name, processPointer, threadPointer, genFn) {
    const pid = nextPid++;
    Process.addThread(processPointer);
    const p = { pid, name, gen: genFn(), state: 'ready',
                processPointer, threadPointer, ownsProcess: false };
    procs.push(p);
    return p.pid;
}

function kill(pid) {
    const p = procs.find(p => p.pid === pid);
    if (!p) return false;
    p.state = 'killed';
    return true;
}

function reap() {
    for (let i = procs.length - 1; i >= 0; i--) {
        if (procs[i].state === 'done' || procs[i].state === 'killed') {
            const p = procs[i];
            if (p.ownsProcess) {
                Process.terminateProcess(p.processPointer);
            } else {
                Process.removeThread(p.processPointer);
                GuestMemory.guestFreeBytes(p.threadPointer);
            }
            procs.splice(i, 1);
        }
    }
}

// um passo de cada processo pronto (round-robin cooperativo); a thread
// corrente durante o passo e' a do processo (como o NT troca gs:[0x188])
function tick() {
    reap();
    for (const p of procs) {
        if (p.state !== 'ready') continue;
        p.state = 'running';
        Process.setCurrentThread(p.threadPointer);
        try {
            if (p.gen.next().done) p.state = 'done';
            else p.state = 'ready';
        } catch (e) {
            os.debugPrint('[sched] processo ' + p.pid + ' (' + p.name + ') morreu: ' + e.message);
            p.state = 'done';
        }
        Process.setCurrentThread(systemThreadPointer);
    }
    reap();
}

function init() {
    Process.init();
    // a "thread do System" (contexto de boot/drivers): gs:[0x188] inicial
    systemThreadPointer = Process.createKernelThread(
        Process.getSystemProcess(), 4);   // idle thread do System, estilo NT
    Process.setCurrentThread(systemThreadPointer);
}

function currentPid() {
    const thread = Process.getCurrentThread();
    if (!thread) return 0;
    return GuestMemory.readGuest64(thread + NtAbi.KTHREAD.CID_UNIQUE_PROCESS);
}

module.exports = {
    spawn, spawnIntoProcess, kill, tick, init,
    list()  { return procs.slice(); },
    count() { return procs.length; },
    currentPid,
};
