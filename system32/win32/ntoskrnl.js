// ===========================================================================
// jsOS - system32/win32/ntoskrnl.js: a tabela de exports do "ntoskrnl" do
// jsOS. Junta os grupos de win32/ntoskrnl/*.js NA ORDEM de groups.js
// (a ABI dos drivers depende dessa ordem; append-only dentro de cada grupo).
// ===========================================================================

const GROUP_ORDER = require('win32/ntoskrnl/groups');

const exportNames = [];
const exportHandlers = [];
for (const groupName of GROUP_ORDER) {
    const group = require('win32/ntoskrnl/' + groupName);
    exportNames.push(...group.names);
    exportHandlers.push(...group.handlers);
}

function lookup(dllName, functionName) {
    // a tabela e' a mesma para ntoskrnl.exe e HAL.dll (no NT de verdade,
    // KeQueryPerformanceCounter/KeStallExecutionProcessor etc. saem da HAL)
    const index = exportNames.indexOf(functionName);
    return index < 0 ? -1 : 32 + index;
}

// handler chamado pelo C (js_win32_dispatch; id ja sem o offset 32)
function handle(id, arg1, arg2, arg3, arg4, arg5, arg6, arg7,
                arg8, arg9, arg10, arg11, arg12) {
    const handlerFunction = exportHandlers[id];
    if (!handlerFunction) {
        os.debugPrint('[ntoskrnl] export desconhecido id=' + id);
        return 0;
    }
    return handlerFunction(arg1, arg2, arg3, arg4, arg5, arg6, arg7,
                           arg8, arg9, arg10, arg11, arg12);
}

// o kernel drena timers + DPCs + work items no idle loop (como o NT ao cair
// de DISPATCH_LEVEL)
function runKernelTasks() {
    require('ntos/ke/timer').checkTimers();
    require('ntos/ke/dpc').runQueue();
    require('ntos/io/work-items').runQueue();
}

// o C (js_win32_dispatch) procura globalThis.Ntoskrnl.handle
globalThis.Ntoskrnl = { handle };

const Lifecycle = require('win32/ntoskrnl/lifecycle');

module.exports = {
    lookup,
    loadDriver: Lifecycle.loadDriver,
    unloadDriver: Lifecycle.unloadDriver,
    getDriverExport: Lifecycle.getDriverExport,
    runKernelTasks,
    exportNames,
};
