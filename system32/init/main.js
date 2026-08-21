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

require('ntos/ex/syscalls');     // registra a tabela SystemCall
const Win32     = require('win32/win32');      // mini-kernel32
const Ntoskrnl  = require('win32/ntoskrnl');   // exports do kernel p/ drivers
const PeLoader  = require('win32/pe-loader');

// o loader PE resolve imports contra as tabelas registradas aqui:
PeLoader.registerResolver(/^kernel32\.dll$/i, (dll, name) => Win32.lookup(dll, name));
PeLoader.registerResolver(/^ntoskrnl\.exe$/i, (dll, name) => Ntoskrnl.lookup(dll, name));

function banner() {
    Console.print('=================================================');
    Console.print(' jsOS v' + Kernel.VERSION + ' - kernel 100% JavaScript');
    Console.print(' bare metal x86-64 (BIOS real mode -> long mode)');
    Console.print(' RAM: ' + Math.floor(os.getRamSize() / 1048576) + ' MB');
    Console.print('=================================================');
}

// servico de teclado: processo que le o driver e publica no canal 'kbd'
// (fluxo nanokernel: driver -> IPC -> consumidor)
function* KbdService() {
    for (;;) {
        const k = Keyboard.pollKey();
        if (k !== null) MessageChannels.send('kbd', k);
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
    os.debugPrint('[kernel] idle loop - escalonador cooperativo ativo');
    for (;;) { Scheduler.tick(); Ntoskrnl.runKernelTasks(); }
}

kmain();
