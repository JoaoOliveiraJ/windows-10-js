// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ps.js: exports Ps* (threads de kernel em
// ntos/ps/kernel-threads.js, sobre o escalonador cooperativo).
// ===========================================================================

const KernelThreads = require('ntos/ps/kernel-threads');
const Process = require('ntos/ps/process');

module.exports = {
    names: [
        'PsCreateSystemThread',
        'PsTerminateSystemThread',
        'PsGetCurrentThreadId',     // () -> KTHREAD.Cid.UniqueThread (caminho do NT)
        'PsGetCurrentProcessId',    // () -> KTHREAD.Cid.UniqueProcess (idem)
        'PsSetCreateProcessNotifyRoutine',      // (callbackPtr, remove)
        'PsRemoveCreateProcessNotifyRoutine',   // (callbackPtr)
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
    ],
};
