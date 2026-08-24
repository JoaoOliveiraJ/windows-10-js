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

// DIRQL por vetor (lido pelo stub asm via o C no despacho imediato: so
// preempta quando currentIrql < dirql — o criterio do HAL do NT)
const IRQ_DIRQL_TABLE = 0x81600;

// desmascara a IRQ no PIC e descarta pendencias velhas (como o HAL faz ao
// conectar um KINTERRUPT: o driver so ve interrupcoes novas, de atividade
// real — nunca um latch do boot anterior a conexao)
function picClearAndUnmask(vectorNumber) {
    const irqNumber = vectorNumber - 0x20;
    if (irqNumber < 0 || irqNumber > 15) return;
    // IDE legacy (IRQ14/15): a linha INTRQ fica assertada enquanto houver um
    // comando completado sem leitura do status, e o DRQ fica armado enquanto
    // houver dados nao lidos de um comando anterior (residuo do boot). O HAL/
    // driver drena esse estado residual ao conectar: status + drenar o data
    // port se DRQ estiver armado — senao a tempestade de IRQs nunca cessa
    if (irqNumber === 14) ideDrainStaleInterrupt(0x1F0, 0x1F7);
    if (irqNumber === 15) ideDrainStaleInterrupt(0x170, 0x177);
    // EOI generico nos dois PICs descarta qualquer pendencia latched
    os.writePort8(0x20, 0x20);
    if (irqNumber >= 8) os.writePort8(0xA0, 0x20);
    if (irqNumber < 8)
        os.writePort8(0x21, os.readPort8(0x21) & ~(1 << irqNumber));
    else
        os.writePort8(0xA1, os.readPort8(0xA1) & ~(1 << (irqNumber - 8)));
}

// drena um comando IDE residual: le o status (limpa INTRQ) e, se houver DRQ
// armado de um comando anterior, consome os 256 words do data port
function ideDrainStaleInterrupt(dataPort, statusPort) {
    const status = os.readPort8(statusPort);
    if (status & 0x08) {   // DRQ
        for (let wordIndex = 0; wordIndex < 256; wordIndex++)
            os.readPort16(dataPort);
    }
}

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
    // publica o DIRQL do vetor p/ o despacho imediato do stub asm
    os.writePhysical32(IRQ_DIRQL_TABLE + vectorNumber * 4, irql & 0xFF);
    // desmascara a IRQ no PIC com pendencias antigas descartadas (como o HAL)
    picClearAndUnmask(vectorNumber);

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
                // cadeia vazia: despublica o DIRQL (sem despacho imediato)
                os.writePhysical32(IRQ_DIRQL_TABLE + vector * 4, 0);
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
