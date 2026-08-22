// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ps.js: exports Ps* (threads de kernel em
// ntos/ps/kernel-threads.js, sobre o escalonador cooperativo).
// ===========================================================================

const KernelThreads = require('ntos/ps/kernel-threads');

module.exports = {
    names: [
        'PsCreateSystemThread',
        'PsTerminateSystemThread',
        'PsGetCurrentThreadId',     // () -> handle da thread nativa corrente
        'PsGetCurrentProcessId',    // () -> 0 (processo System, como o NT)
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
        // PsGetCurrentThreadId()
        () => KernelThreads.getCurrentThreadHandle(),
        // PsGetCurrentProcessId(): drivers rodam no contexto do System (0)
        () => 0,
    ],
};
