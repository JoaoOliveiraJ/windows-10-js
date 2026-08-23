// ===========================================================================
// jsOS - system32/ntos/ke/interrupt-object.js: KINTERRUPT real (estilo NT).
//
// IoConnectInterrupt cria o objeto KINTERRUPT, liga na cadeia do vetor e o
// ISR **nativo** do driver passa a ser chamado pelo dispatch de IRQ (a IRQ
// chega no stub asm -> conta -> o JS despacha -> execMsAbi chama a rotina
// do driver, que le portas/fila DPC como no Windows).
//
// Semantica do NT: cadeia por vetor; cada ISR retorna BOOLEAN (TRUE = eu
// tratei). Em modo Latched (edge) para no primeiro TRUE; em LevelSensitive
// percorre a cadeia inteira. KeSynchronizeExecution roda a rotina com o
// spinlock do interrupt segurado, no IRQL de sincronismo.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');
const Irql = require('ntos/ke/irql');
const Interrupts = require('nano/interrupts');

const KI = NtAbi.KINTERRUPT;

// flag compartilhada com hal/core/irqstubs.asm: quando 1, o stub NAO le a
// porta 0x60 na IRQ1 (o ISR nativo do port driver e' quem le o 8042)
const NATIVE_IRQ1_FLAG = 0x81510;

const chainHeadByVector = new Map();   // vector -> primeiro KINTERRUPT ptr

function readGuest8(a)  { return os.readPhysical8(a); }
function readGuest32(a) { return os.readPhysical32(a) >>> 0; }
function readGuest64(a) {
    return os.readPhysical32(a) + os.readPhysical32(a + 4) * 0x100000000;
}
function writeGuest32(a, v) { os.writePhysical32(a, v >>> 0); }
function writeGuest64(a, v) {
    os.writePhysical32(a, v >>> 0);
    os.writePhysical32(a + 4, Math.floor(v / 0x100000000) >>> 0);
}

// spinlock de convidado (KSPIN_LOCK = u64; 0=livre) — mesmo modelo dos Ke*
function acquireLock(lockPointer) {
    for (;;) {
        if (readGuest32(lockPointer) === 0 && readGuest32(lockPointer + 4) === 0) {
            writeGuest32(lockPointer, 1);
            return;
        }
    }
}
function releaseLock(lockPointer) { writeGuest32(lockPointer, 0); }

// despacho do vetor: percorre a cadeia chamando os ISRs nativos
function dispatchChain(vector) {
    let current = chainHeadByVector.get(vector) || 0;
    while (current) {
        const serviceRoutine = readGuest64(current + KI.SERVICE_ROUTINE);
        const serviceContext = readGuest64(current + KI.SERVICE_CONTEXT);
        const mode = readGuest32(current + KI.MODE);
        // PKSERVICE_ROUTINE: BOOLEAN Isr(PKINTERRUPT, PVOID serviceContext)
        const handled = os.execMsAbi(serviceRoutine, current, serviceContext);
        if (handled && mode === 0) return;   // Latched: para no 1o que trata
        current = readGuest64(current + KI.LIST_ENTRY);   // Flink
    }
}

// IoConnectInterrupt(outKiPtr, isr, context, spinlock(ou 0), vector, irql,
//                    syncIrql, mode, shareable, affinity, floatingSave)
// — assinatura REAL do WDM (11 args; 5+ chegam pela pilha: mascarar ints)
function ioConnectInterrupt(outInterruptPointer, serviceRoutine, serviceContext,
                            spinLockPointer, vector, irql, synchronizeIrql,
                            interruptMode, shareVector, _affinity,
                            _floatingSave) {
    const vectorNumber = vector >>> 0;
    const kinterruptPointer = GuestMemory.guestAllocBytes(KI.SIZE);
    // spinlock: usa o do chamador se ele passou um; senao aloca o interno
    const actualLock = spinLockPointer
        ? spinLockPointer >>> 0
        : GuestMemory.guestAllocBytes(8);
    if (!spinLockPointer) writeGuest32(actualLock, 0);

    writeGuest32(kinterruptPointer + KI.TYPE,
                 KI.TYPE_INTERRUPT | (KI.SIZE << 16));      // Type+Size juntos
    writeGuest64(kinterruptPointer + KI.LIST_ENTRY, 0);     // Flink
    writeGuest64(kinterruptPointer + KI.LIST_ENTRY + 8, 0); // Blink
    writeGuest64(kinterruptPointer + KI.SERVICE_ROUTINE, serviceRoutine);
    writeGuest64(kinterruptPointer + KI.SERVICE_CONTEXT, serviceContext);
    writeGuest64(kinterruptPointer + KI.SPIN_LOCK, spinLockPointer >>> 0);
    writeGuest64(kinterruptPointer + KI.ACTUAL_LOCK, actualLock);
    writeGuest32(kinterruptPointer + KI.VECTOR, vectorNumber);
    os.writePhysical8(kinterruptPointer + KI.IRQL, irql & 0xFF);
    os.writePhysical8(kinterruptPointer + KI.SYNCHRONIZE_IRQL,
                      synchronizeIrql & 0xFF);
    os.writePhysical8(kinterruptPointer + KI.CONNECTED, 1);
    writeGuest32(kinterruptPointer + KI.MODE, interruptMode >>> 0);
    os.writePhysical8(kinterruptPointer + KI.SHARE_VECTOR, shareVector ? 1 : 0);

    // entra no INICIO da cadeia do vetor (LIFO, como o NT)
    const previousHead = chainHeadByVector.get(vectorNumber) || 0;
    writeGuest64(kinterruptPointer + KI.LIST_ENTRY, previousHead);
    chainHeadByVector.set(vectorNumber, kinterruptPointer);

    // primeira ISR do vetor: liga o despacho JS -> cadeia nativa
    if (!previousHead) {
        Interrupts.registerIrqHandler(vectorNumber, dispatchChain);
        // IRQ1 com port driver nativo: o stub para de ler a porta 0x60
        if (vectorNumber === Interrupts.VECTOR_KEYBOARD)
            os.writePhysical8(NATIVE_IRQ1_FLAG, 1);
        os.debugPrint('[intobj] vetor 0x' + vectorNumber.toString(16) +
                      ' conectado a ISR nativa 0x' +
                      (serviceRoutine >>> 0).toString(16));
    }

    // devolve o objeto no out-param (PKINTERRUPT* = primeiro argumento)
    writeGuest32(outInterruptPointer, kinterruptPointer >>> 0);
    writeGuest32(outInterruptPointer + 4, 0);
    return 0;   // STATUS_SUCCESS
}

// IoDisconnectInterrupt(ki): tira da cadeia e libera (semantica NT)
function ioDisconnectInterrupt(kinterruptPointer) {
    const vector = readGuest32(kinterruptPointer + KI.VECTOR);
    let previousLink = 0;
    let current = chainHeadByVector.get(vector) || 0;
    while (current) {
        const next = readGuest64(current + KI.LIST_ENTRY);
        if (current === kinterruptPointer) {
            if (previousLink) writeGuest64(previousLink + KI.LIST_ENTRY, next);
            else if (next) chainHeadByVector.set(vector, next);
            else chainHeadByVector.delete(vector);
            os.writePhysical8(kinterruptPointer + KI.CONNECTED, 0);
            GuestMemory.guestFreeBytes(kinterruptPointer);
            if (!next && !previousLink && !(chainHeadByVector.get(vector))) {
                // cadeia vazia: o stub do teclado volta a ler a porta 0x60
                if (vector === Interrupts.VECTOR_KEYBOARD)
                    os.writePhysical8(NATIVE_IRQ1_FLAG, 0);
            }
            return;
        }
        previousLink = current;
        current = next;
    }
}

// KeSynchronizeExecution(ki, syncRoutine, context): roda a rotina com o
// ActualLock segurado e IRQL no SynchronizeIrql — exclusao mutua com o ISR
// (PKSYNCHRONIZE_ROUTINE: BOOLEAN routine(PVOID context))
function keSynchronizeExecution(kinterruptPointer, syncRoutine, context) {
    const actualLock = readGuest64(kinterruptPointer + KI.ACTUAL_LOCK);
    const syncIrql = os.readPhysical8(kinterruptPointer + KI.SYNCHRONIZE_IRQL);
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(syncIrql);
    acquireLock(actualLock);
    const result = os.execMsAbi(syncRoutine, context, 0);
    releaseLock(actualLock);
    Irql.lowerIrql(oldIrql);
    return result;
}

function isVectorConnected(vector) {
    return chainHeadByVector.has(vector);
}

module.exports = { ioConnectInterrupt, ioDisconnectInterrupt,
                   keSynchronizeExecution, isVectorConnected };
