// ===========================================================================
// jsOS - system32/init/main.js: ponto de entrada (KiSystemStartup do jsOS).
//
// Boot em fases, estilo NT: fase 0 (nucleo minimo) -> fase 1 (I/O, drivers,
// servicos do Registry, PnP). A camada C (hal/) so oferece as primitivas os.*.
// ===========================================================================

// unico eval direto: o bootstrap dos modulos
(function bootstrap() {
    const src = os.readBundleText('system32/ntos/rtl/module.js');
    if (src === null) { os.debugPrint('FALTA system32/ntos/rtl/module.js no bundle'); os.halt(); }
    (0, eval)(src + '\n//# sourceURL=system32/ntos/rtl/module.js');
})();

const require = JSOS.require;

globalThis.Kernel = { VERSION: '0.6.0' };

const VGA              = require('drivers/video/vga');
const Console          = require('drivers/console/console');
const Scheduler        = require('ntos/ps/scheduler');
const SelfTest         = require('ntos/test/self-test');
const Keyboard         = require('drivers/input/keyboard');
const MessageChannels  = require('nano/message-channels');
const Phase0           = require('init/phase0');
const Phase1           = require('init/phase1');
const Shell            = require('shell/shell');
const SharedUserData   = require('ntos/mm/shared-user-data');
const Interrupts       = require('nano/interrupts');

require('ntos/ex/syscalls');     // registra a tabela SystemCall
const Win32     = require('win32/win32');      // mini-kernel32
const Ntoskrnl  = require('win32/ntoskrnl');   // exports do kernel p/ drivers
const PeLoader  = require('win32/pe-loader');

// o loader PE resolve imports contra as tabelas registradas aqui:
PeLoader.registerResolver(/^kernel32\.dll$/i, (dll, name) => Win32.lookup(dll, name));
PeLoader.registerResolver(/^ntoskrnl\.exe$/i, (dll, name) => Ntoskrnl.lookup(dll, name),
                          (dll, ordinal) => Ntoskrnl.lookupOrdinal(dll, ordinal));
PeLoader.registerResolver(/^hal\.dll$/i, (dll, name) => Ntoskrnl.lookup(dll, name),
                          (dll, ordinal) => Ntoskrnl.lookupOrdinal(dll, ordinal));
PeLoader.registerResolver(/^wmilib\.sys$/i, (dll, name) => Ntoskrnl.lookup(dll, name));
PeLoader.registerResolver(/^wpprecorder\.sys$/i, (dll, name) => Ntoskrnl.lookup(dll, name));
// modulo-a-modulo (driver importando de outro .sys: disk->CLASSPNP, atapi->
// ataport): carrega o modulo dependente por completo (PE + DriverEntry, como
// o MmLoadSystemImage do NT) e devolve o ENDERECO NATIVO do export — a IAT do
// importador recebe o ponteiro real, sem trampolim (nativo chama nativo)
PeLoader.registerResolver(/\.sys$/i, (dllName, functionName) => {
    const Lifecycle = require('win32/ntoskrnl/lifecycle');
    const dependencyNode = Lifecycle.ensureModuleDriverLoaded(dllName);
    if (!dependencyNode)
        throw new Error('modulo dependente falhou ao carregar: ' + dllName);
    const exportAddress = dependencyNode.data.exports[functionName];
    if (!exportAddress)
        throw new Error('export ausente: ' + dllName + '!' + functionName);
    return { address: exportAddress };
});

function banner() {
    Console.print('=================================================');
    Console.print(' jsOS v' + Kernel.VERSION + ' - kernel 100% JavaScript');
    Console.print(' bare metal x86-64 (BIOS real mode -> long mode)');
    Console.print(' RAM: ' + Math.floor(os.getRamSize() / 1048576) + ' MB');
    Console.print('=================================================');
}

// servico de teclado: processo que le do device de classe REAL do kbdclass
// (\Device\KeyboardClass0, alimentado pelo i8042prt.sys da Microsoft) e
// publica os chars no canal 'kbd' (fluxo nanokernel: driver -> IPC -> shell).
// Um READ fica pendente; a tecla atravessa IRQ1->ISR->DPC->callback e o
// completa — o processo so rende e a main loop despacha IRQ/DPC entre ticks.
function* KbdService() {
    const IoManager = require('ntos/io/io-manager');
    const Dispatcher = require('ntos/ke/dispatcher');
    const GuestMemory = require('win32/guest-memory');
    const decodeKey = Keyboard.decode;
    // a porta i8042 ja esta aberta (o selftest a abriu — open count != 0)
    const kbd = IoManager.openDevice('\\Device\\KeyboardClass0');
    if (kbd.status !== 0) { os.debugPrint('[kbd] KeyboardClass0 indisponivel'); return; }
    os.debugPrint('[kbd] lendo teclas do driver real (i8042prt+kbdclass)');
    const eventPointer = GuestMemory.guestAllocBytes(0x18);
    const zeroTimeoutPtr = GuestMemory.guestAllocBytes(8);  // LARGE_INTEGER 0
    let pendingRead = null;
    // despeja KEYBOARD_INPUT_DATA -> ASCII -> canal 'kbd'
    const pumpData = (dataPointer, info) => {
        for (let off = 0; off + 12 <= info; off += 12) {
            const makeCode = GuestMemory.readGuest16(dataPointer + off + 2);
            const flags = GuestMemory.readGuest16(dataPointer + off + 4);
            const scancode = (flags & 1) ? (makeCode | 0x80) : makeCode;
            const ch = decodeKey(scancode);
            if (ch !== null) MessageChannels.send('kbd', ch);
        }
    };
    for (;;) {
        if (!pendingRead) {
            Dispatcher.initializeEvent(eventPointer, 0, 0);
            const readRequest = IoManager.readHandle(kbd.handle, {
                userEvent: eventPointer, bufferLength: 48,
            });
            if (readRequest.status === 0 && readRequest.info > 0) {
                // dados ja na fila: result tem os bytes como string
                const text = readRequest.result;
                for (let off = 0; off + 12 <= readRequest.info; off += 12) {
                    const makeCode = text.charCodeAt(off + 2) | (text.charCodeAt(off + 3) << 8);
                    const flags = text.charCodeAt(off + 4);
                    const ch = decodeKey((flags & 1) ? (makeCode | 0x80) : makeCode);
                    if (ch !== null) MessageChannels.send('kbd', ch);
                }
            } else if (readRequest.status === 0x103) {
                pendingRead = readRequest;
            }
        } else if (Dispatcher.waitForSingleObject(eventPointer, zeroTimeoutPtr) === 0) {
            // o READ completou: le os dados ANTES de liberar
            const dataPointer = pendingRead.pendingBufferAddress;
            const info = GuestMemory.readGuest64(pendingRead.pendingIrpAddress +
                                                 0x38 /* IoStatus.Information */);
            pumpData(dataPointer, info);
            IoManager.waitPendingIoRequest(pendingRead, 0);
            pendingRead = null;
        }
        yield;
    }
}

function kmain() {
    VGA.clear();
    banner();

    Phase0.init();              // nanokernel + objetos + registry (hive de servicos)
    Phase1.init();              // I/O manager + drivers internos + NTFS + servicos + PnP

    os.debugPrint('KERNEL_JS_OK');      // kernel JS montado e executando
    SelfTest.run();                // imprime SELFTEST_OK

    // processos: servico de teclado (IPC) + shell
    Scheduler.spawn('kbd-service', KbdService);
    Scheduler.spawn('shell', Shell.main);

    // PREEMPCAO POR TIMER: cada IRQ0 (100 Hz) e' um quantum — o escalonador
    // roda um passo por quantum de hardware. Se a plataforma nao entregar
    // IRQs (WHPX antigo), cai no modo cooperativo com log claro.
    const Clock = require('ntos/ke/clock');
    Interrupts.registerIrqHandler(Interrupts.VECTOR_LAPIC_TIMER,
        () => Scheduler.tick());
    const cooperativeFallback = () => {
        const warmupEnd = Clock.uptimeMs() + 300;
        while (Clock.uptimeMs() < warmupEnd) {
            SharedUserData.updateSystemTimes();
            Ntoskrnl.runKernelTasks();
            Interrupts.dispatchPending();
            Scheduler.tick();   // cooperativo durante o warmup
        }
        return Interrupts.irqsArriving();
    };
    if (cooperativeFallback()) {
        os.debugPrint('[kernel] preempcao por timer ativa (quantum 10ms, LAPIC timer vetor 0x40)');
        for (;;) {
            SharedUserData.updateSystemTimes();
            Ntoskrnl.runKernelTasks();
            Interrupts.dispatchPending();   // IRQ0 -> Scheduler.tick()
        }
    } else {
        os.debugPrint('[kernel] AVISO: plataforma nao entrega IRQs — ' +
                      'escalonador cooperativo (sem preempcao)');
        for (;;) {
            SharedUserData.updateSystemTimes();
            Ntoskrnl.runKernelTasks();
            Interrupts.dispatchPending();
            Scheduler.tick();
        }
    }
}

kmain();
