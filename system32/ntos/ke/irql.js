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

// IRQL publicado p/ o despacho imediato de ISR nativa (lido pelo stub asm
// via o C: so preempta quando currentIrql < DIRQL do vetor, como o HAL)
const CURRENT_IRQL_ADDRESS = 0x81528;
function publishIrql() { os.writePhysical32(CURRENT_IRQL_ADDRESS, currentIrql); }

function getIrql() { return currentIrql; }

function raiseIrql(newIrql) {
    if (newIrql < currentIrql) {
        os.debugPrint('[ke] BUGCHECK: KeRaiseIrql p/ nivel menor (' +
                      newIrql + ' < ' + currentIrql + ')');
        os.halt();
    }
    const old = currentIrql;
    currentIrql = newIrql;
    publishIrql();
    return old;
}

function lowerIrql(newIrql) {
    if (newIrql > currentIrql) {
        os.debugPrint('[ke] BUGCHECK: KeLowerIrql para nivel maior (0x' +
                      (newIrql >>> 0).toString(16) + ' | hi=0x' +
                      Math.floor(newIrql / 0x100000000).toString(16) +
                      ' > ' + currentIrql + ')');
        os.halt();
    }
    currentIrql = newIrql;
    publishIrql();
}

module.exports = { PASSIVE_LEVEL, DISPATCH_LEVEL, HIGH_LEVEL,
                   getIrql, raiseIrql, lowerIrql };
