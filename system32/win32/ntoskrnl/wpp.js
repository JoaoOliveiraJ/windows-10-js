// ===========================================================================
// jsOS - system32/win32/ntoskrnl/wpp.js: exports da WppRecorder.sys (WPP
// software tracing). Implementacao real: as sessoes de trace existem de
// verdade (estado + buffer circular por sessao) e os eventos saem na serial
// — o "recorder" do jsOS.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

const traceSessions = new Map();   // handle -> { buffer: string[] }
let nextTraceHandle = 1;

module.exports = {
    names: [
        'WppAutoLogStart',
        'WppAutoLogTrace',
        'WppAutoLogStop',
        'imp_WppRecorderReplay',
    ],
    handlers: [
        // WppAutoLogStart(autologgerGuidPtr, outHandlePtr, enableCallbackPtr):
        // inicia uma sessao de trace real (buffer circular de 256 eventos)
        (_guidPointer, outHandlePointer, _enableCallback) => {
            const traceHandle = nextTraceHandle++;
            traceSessions.set(traceHandle, { events: [] });
            if (outHandlePointer)
                GuestMemory.writeGuest64(outHandlePointer, traceHandle);
            return 0;
        },
        // WppAutoLogTrace(handle, level, flags, guid, msgNumber, params...):
        // registra o evento pelo NUMERO da mensagem (o conteudo WPP e'
        // binario — a formatacao acontece offline via TMF no Windows)
        (traceHandle, _level, _flags, _guidPointer, messageNumber) => {
            const session = traceSessions.get(traceHandle >>> 0);
            const line = '[wpp] evento msg#' + (messageNumber >>> 0);
            if (session) {
                session.events.push(line);
                if (session.events.length > 256) session.events.shift();
            }
            os.debugPrint(line);
            return 0;
        },
        // WppAutoLogStop(handle, guid): encerra a sessao (eventos ficam no log)
        (traceHandle, _guidPointer) => {
            traceSessions.delete(traceHandle >>> 0);
            return 0;
        },
        // imp_WppRecorderReplay(handle, ...): replay do buffer circular
        (traceHandle) => {
            const session = traceSessions.get(traceHandle >>> 0);
            if (!session) return 0xC0000008 | 0;
            for (const line of session.events) os.debugPrint('[replay] ' + line);
            return 0;
        },
    ],
};
