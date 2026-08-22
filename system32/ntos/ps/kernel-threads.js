// ===========================================================================
// jsOS - system32/ntos/ps/kernel-threads.js: threads de kernel (estilo NT).
//
// PsCreateSystemThread cria uma thread de kernel: um processo no escalonador
// cooperativo que roda a rotina nativa (startRoutine) ate ela retornar ou
// chamar PsTerminateSystemThread. Handles numericos mapeiam pid <-> handle.
// ===========================================================================

const Scheduler = require('ntos/ps/scheduler');
const Process = require('ntos/ps/process');

let nextThreadHandle = 0x800;
const threadTable = new Map();   // handle -> { pid, threadPointer }
let currentThreadHandle = 0;     // thread nativa em execucao (0 = nenhuma)

function createSystemThread(outHandlePointer, startRoutine, contextPointer) {
    const handle = nextThreadHandle++;
    // KTHREAD real: threads de drivers vivem no processo System (como o NT)
    const threadPointer = Process.createKernelThread(
        Process.getSystemProcess(), handle);
    function* threadProc() {
        currentThreadHandle = handle;
        const previousThread = Process.getCurrentThread();
        Process.setCurrentThread(threadPointer);   // contexto da thread
        os.execMsAbi(startRoutine, contextPointer, 0);
        Process.setCurrentThread(previousThread);
        currentThreadHandle = 0;
        // retorno natural = fim da thread
    }
    const pid = Scheduler.spawnIntoProcess('kt-' + handle,
        Process.getSystemProcess(), threadPointer, threadProc);
    threadTable.set(handle, { pid, threadPointer });
    if (outHandlePointer) {
        os.writePhysical32(outHandlePointer, handle >>> 0);
        os.writePhysical32(outHandlePointer + 4, 0);
    }
    return handle;
}

function terminateCurrentThread() {
    // marca o processo atual como terminado; o escalonador faz o reap
    const entry = threadTable.get(currentThreadHandle);
    if (entry) {
        Scheduler.kill(entry.pid);
        threadTable.delete(currentThreadHandle);
    }
    return 0;
}

function getCurrentThreadHandle() { return currentThreadHandle; }

module.exports = { createSystemThread, terminateCurrentThread, getCurrentThreadHandle };
