// ===========================================================================
// jsOS - system32/ntos/ke/irql.js: estado de IRQL do kernel (estilo NT).
//
// PASSIVE_LEVEL(0) -> APC(1) -> DISPATCH(2) -> DIRQL -> HIGH(15).
// O estado e global do kernel; DPCs rodam a DISPATCH_LEVEL. Regras reais:
// KeRaiseIrql nao desce (BUGCHECK se tentar), KeLowerIrql nao sobe.
// ===========================================================================

let currentIrql = 0;   // PASSIVE_LEVEL

const PASSIVE_LEVEL = 0;
const DISPATCH_LEVEL = 2;
const HIGH_LEVEL = 15;

function getIrql() { return currentIrql; }

function raiseIrql(newIrql) {
    if (newIrql < currentIrql) {
        os.debugPrint('[ke] BUGCHECK: KeRaiseIrql p/ nivel menor (' +
                      newIrql + ' < ' + currentIrql + ')');
        os.halt();
    }
    const old = currentIrql;
    currentIrql = newIrql;
    return old;
}

function lowerIrql(newIrql) {
    if (newIrql > currentIrql) {
        os.debugPrint('[ke] BUGCHECK: KeLowerIrql para nivel maior');
        os.halt();
    }
    currentIrql = newIrql;
}

module.exports = { PASSIVE_LEVEL, DISPATCH_LEVEL, HIGH_LEVEL,
                   getIrql, raiseIrql, lowerIrql };
