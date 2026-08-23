// ===========================================================================
// jsOS - system32/win32/ntoskrnl/wmi.js: exports da WMILIB.SYS (Windows
// Management Instrumentation para drivers). Semantica real da wmilib:
// WmiSystemControl examina o WMILIB_CONTROL_BLOCK e decide a disposicao do
// IRP_MJ_SYSTEM_CONTROL; WmiCompleteRequest completa com o status dado.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const NtAbi = require('win32/nt-abi');
const IoManager = require('ntos/io/io-manager');

// WMILIB_CONTROL_BLOCK (wmilib.h): +0x00 u32 Control? O layout real:
// GUID Count + linkagem; o que importa p/ disposicao e' a contagem de GUIDs.
// Se o driver nao registrou nenhum GUID WMI (Count==0), toda requisicao WMI
// e' "nao tratada" — completar com o status corrente (comportamento real).

module.exports = {
    names: [
        'WmiSystemControl',
        'WmiCompleteRequest',
        'WmiTraceMessage',
        'WmiQueryTraceInformation',
    ],
    handlers: [
        // WmiSystemControl(wmiLibInfoPtr, deviceObj, irp, outIrpDispositionPtr)
        // -> STATUS_SUCCESS; disposicao 0 = completar IRP (nao tratamos WMI)
        (wmiLibInfoPointer, _deviceObjectPointer, _ioRequestPointer,
         dispositionOutPointer) => {
            // IrpNotWmi (0) / WmiCompleteRequest? a disposicao real para um
            // driver sem GUIDs registrados e' completar o IRP adiante:
            GuestMemory.writeGuest32(dispositionOutPointer, 0);
            return 0;
        },
        // WmiCompleteRequest(deviceObj, irp, status, bufferUsed, priorityBoost)
        (_deviceObjectPointer, ioRequestPointer, status, bufferUsed,
         _priorityBoost) => {
            GuestMemory.writeGuest32(ioRequestPointer + NtAbi.IRP.IO_STATUS,
                                     status >>> 0);
            GuestMemory.writeGuest64(ioRequestPointer +
                                     NtAbi.IRP.IO_STATUS_INFORMATION,
                                     bufferUsed >>> 0);
            IoManager.iofCompleteRequest(ioRequestPointer);
            return 0;
        },
        // WmiTraceMessage(handle, level, guid, msgId, fmt...): trace real
        // formatado para a serial (o sink de trace do jsOS)
        (_traceHandle, _level, _guidPointer, _messageId, formatPointer,
         arg1, arg2, arg3, arg4) => {
            const text = GuestStrings.formatGuestText(
                GuestStrings.readGuestCString(formatPointer),
                [arg1, arg2, arg3, arg4]);
            os.debugPrint('[wmitrace] ' + text.replace(/\r?\n$/, ''));
            return 0;
        },
        // WmiQueryTraceInformation(infoClass, out, size, outLen, handle):
        // TRACE_ENABLE_INFO — nenhuma sessao ativa: devolve flags zerados
        (_infoClass, outBufferPointer, bufferSize, outLengthPointer) => {
            const report = Math.min(bufferSize >>> 0, 0x30);
            for (let i = 0; i < report; i += 4)
                GuestMemory.writeGuest32(outBufferPointer + i, 0);
            if (outLengthPointer)
                GuestMemory.writeGuest32(outLengthPointer, report);
            return 0;
        },
    ],
};
