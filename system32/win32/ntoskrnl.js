// ===========================================================================
// jsOS - system32/win32/ntoskrnl.js: a tabela de exports do "ntoskrnl" do
// jsOS. Junta os grupos de win32/ntoskrnl/*.js NA ORDEM de groups.js
// (a ABI dos drivers depende dessa ordem; append-only dentro de cada grupo).
// ===========================================================================

const GROUP_ORDER = require('win32/ntoskrnl/groups');
const KeTimer = require('ntos/ke/timer');
const KeDpc = require('ntos/ke/dpc');
const WorkItems = require('ntos/io/work-items');
const IoTimer = require('ntos/io/io-timer');

const exportNames = [];
const exportHandlers = [];
for (const groupName of GROUP_ORDER) {
    const group = require('win32/ntoskrnl/' + groupName);
    exportNames.push(...group.names);
    exportHandlers.push(...group.handlers);
}
// guarda de integridade da ABI: name sem handler (ou vice-versa) desalinha
// TODOS os ids dali pra frente — falhar alto no boot em vez de chamar errado
if (exportNames.length !== exportHandlers.length) {
    os.debugPrint('[ntoskrnl] FATAL: ' + exportNames.length + ' names x ' +
                  exportHandlers.length + ' handlers (grupo desalinhado)');
    os.halt();
}

function lookup(dllName, functionName) {
    // a tabela e' a mesma para ntoskrnl.exe e HAL.dll (no NT de verdade,
    // KeQueryPerformanceCounter/KeStallExecutionProcessor etc. saem da HAL)
    const index = exportNames.indexOf(functionName);
    return index < 0 ? -1 : 32 + index;
}

// ordinal N da nossa .def = indice N-1 da tabela (ordem de groups.js)
function lookupOrdinal(dllName, ordinal) {
    if (ordinal < 1 || ordinal > exportNames.length) return -1;
    return 32 + (ordinal - 1);
}

// handler chamado pelo C (js_win32_dispatch; id ja sem o offset 32)
function handle(id, arg1, arg2, arg3, arg4, arg5, arg6, arg7,
                arg8, arg9, arg10, arg11, arg12, arg13, arg14) {
    const handlerFunction = exportHandlers[id];
    if (globalThis.__traceApiCalls)
        os.debugPrint('[api] ' + (exportNames[id] || ('#' + id)));
    if (!handlerFunction) {
        os.debugPrint('[ntoskrnl] export desconhecido id=' + id);
        return 0;
    }
    return handlerFunction(arg1, arg2, arg3, arg4, arg5, arg6, arg7,
                           arg8, arg9, arg10, arg11, arg12, arg13, arg14);
}

// o kernel drena timers + DPCs + work items + io timers no idle loop (como o
// NT ao cair de DISPATCH_LEVEL)
function runKernelTasks() {
    KeTimer.checkTimers();
    KeDpc.runQueue();
    WorkItems.runQueue();
    IoTimer.checkIoTimers();
}

// o C (js_win32_dispatch) procura globalThis.Ntoskrnl.handle
globalThis.Ntoskrnl = { handle };

const Lifecycle = require('win32/ntoskrnl/lifecycle');

// o mm.js resolve exports pela tabela montada aqui (registro, sem ciclo)
require('win32/ntoskrnl/mm').registerRoutineLookup(lookup);

module.exports = {
    lookup,
    lookupOrdinal,
    loadDriver: Lifecycle.loadDriver,
    unloadDriver: Lifecycle.unloadDriver,
    getDriverExport: Lifecycle.getDriverExport,
    runKernelTasks,
    exportNames,
};
