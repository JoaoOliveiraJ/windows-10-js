// ===========================================================================
// jsOS - system32/win32/ntoskrnl/kd.js: a familia Kd* (kernel debugger).
//
// Nosso sistema NAO tem debugger anexado (sem KD transport/serial 16550 de
// debug) — entao os valores reais sao os de um Windows bootado sem /DEBUG:
// KdDebuggerEnabled=FALSE, KdEnableDebugger=ACCESS_DENIED, KdChangeOption=
// DEBUGGER_INACTIVE. Sao respostas REAIS do estado, nao stubs.
// ===========================================================================

// estado real do debugger no jsOS: nao presente, desabilitado no boot
const kdDebuggerEnabled = 0;
const kdDebuggerNotPresent = 1;

const STATUS_SUCCESS = 0;
const STATUS_ACCESS_DENIED = 0xC0000022 | 0;
const STATUS_DEBUGGER_INACTIVE = 0xC0000354 | 0;

module.exports = {
    names: [
        'KdDebuggerEnabled',            // -> BOOLEAN: debugger ativo?
        'KdEnableDebugger',             // tenta ligar o KD no runtime
        'KdRefreshDebuggerNotPresent',  // re-avalia a presenca do KD
        'KdChangeOption',               // query/set de opcoes do KD
        'DbgBreakPointWithStatus',      // int 3 com status (bugcheck sem KD)
        'KdDebuggerNotPresent',         // -> BOOLEAN: nenhum KD anexado
    ],
    handlers: [
        // KdDebuggerEnabled() -> BOOLEAN (0 = sem debugger, estado real)
        () => kdDebuggerEnabled,
        // KdEnableDebugger(): num boot sem /DEBUG o NT recusa — ACCESS_DENIED
        () => STATUS_ACCESS_DENIED,
        // KdRefreshDebuggerNotPresent(): re-avalia (continua nao-presente) e
        // devolve o estado atualizado — retorna "not present" (1)
        () => kdDebuggerNotPresent,
        // KdChangeOption(option, ...): sem KD ativo -> DEBUGGER_INACTIVE
        // (o codigo real do NT quando o subsistema de debug esta inativo)
        (_option, _param2, _param3, _param4, _param5) =>
            STATUS_DEBUGGER_INACTIVE,
        // DbgBreakPointWithStatus(status): num kernel sem KD, um int 3 nao
        // tratado vira KMODE_EXCEPTION_NOT_HANDLED — o desfecho real aqui:
        // log com o status e halt (mesmo efeito observavel do bugcheck)
        (status) => {
            os.debugPrint('[kd] DbgBreakPointWithStatus status=0x' +
                          (status >>> 0).toString(16) +
                          ' sem debugger — KMODE_EXCEPTION_NOT_HANDLED');
            os.halt();
            return 0;
        },
        // KdDebuggerNotPresent() -> 1: nenhum kernel debugger foi anexado no
        // boot (sem /DEBUG no bootloader — estado real, mesma variavel do
        // KdRefreshDebuggerNotPresent acima)
        () => kdDebuggerNotPresent,
    ],
    kdDebuggerEnabled,
    kdDebuggerNotPresent,
    STATUS_SUCCESS,
};
