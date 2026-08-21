// ===========================================================================
// jsOS - system32/ntos/ps/kernel-threads.js: threads de kernel (estilo NT).
//
// PsCreateSystemThread cria uma thread de kernel: um processo no escalonador
// cooperativo que roda a rotina nativa (startRoutine) ate ela retornar ou
// chamar PsTerminateSystemThread. Handles numericos mapeiam pid <-> handle.
// ===========================================================================

const Scheduler = require('ntos/ps/scheduler');

let nextThreadHandle = 0x800;
const threadTable = new Map();   // handle -> pid do processo
let currentThreadHandle = 0;     // thread nativa em execucao (0 = nenhuma)

function createSystemThread(outHandlePointer, startRoutine, contextPointer) {
    function* threadProc() {
        currentThreadHandle = handle;
        os.execMsAbi(startRoutine, contextPointer, 0);
        currentThreadHandle = 0;
        // retorno natural = fim da thread
    }
    const handle = nextThreadHandle++;
    const pid = Scheduler.spawn('kt-' + handle, threadProc);
    threadTable.set(handle, pid);
    if (outHandlePointer) {
        os.writePhysical32(outHandlePointer, handle >>> 0);
        os.writePhysical32(outHandlePointer + 4, 0);
    }
    return handle;
}

function terminateCurrentThread() {
    // marca o processo atual como terminado; o escalonador faz o reap
    const pid = threadTable.get(currentThreadHandle);
    if (pid !== undefined) {
        Scheduler.kill(pid);
        threadTable.delete(currentThreadHandle);
    }
    return 0;
}

function getCurrentThreadHandle() { return currentThreadHandle; }

module.exports = { createSystemThread, terminateCurrentThread, getCurrentThreadHandle };
