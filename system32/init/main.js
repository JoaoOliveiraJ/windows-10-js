// ===========================================================================
// jsOS - system32/init/main.js: ponto de entrada e raiz de composicao.
//
// Sobe o sistema de modulos (ntos/rtl/module.js) e monta o sistema
// operacional inteiro em JavaScript com require(): nano, ntos, drivers,
// win32, shell. A camada C (hal/) so oferece as primitivas os.*.
// ===========================================================================

// unico eval direto: o bootstrap dos modulos
(function bootstrap() {
    const src = os.readBundleText('system32/ntos/rtl/module.js');
    if (src === null) { os.debugPrint('FALTA system32/ntos/rtl/module.js no bundle'); os.halt(); }
    (0, eval)(src + '\n//# sourceURL=system32/ntos/rtl/module.js');
})();

const require = JSOS.require;

globalThis.Kernel = { VERSION: '0.5.0' };

// ---- monta o sistema (cada subsistema e um modulo exportavel) ----
// nanokernel primeiro: interrupcoes, canais de mensagem, servicos
const Interrupts       = require('nano/interrupts');
const MessageChannels  = require('nano/message-channels');
const NanoKernel       = require('nano/kernel');
const VGA              = require('drivers/video/vga');
const Console          = require('drivers/console/console');
const MemoryFileSystem = require('ntos/fs/memory-file-system');
const Scheduler        = require('ntos/ps/scheduler');
const SelfTest         = require('ntos/test/self-test');
const ObjectManager    = require('ntos/ob/object-manager');
const IoManager        = require('ntos/io/io-manager');
const AtaPio           = require('drivers/storage/ata-pio');
const Keyboard         = require('drivers/input/keyboard');
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

function seedVfs() {
    // todo arquivo de apps/ vira arquivo do MemoryFileSystem ( /<basename> )
    for (const name of os.listBundleFiles()) {
        if (!name.startsWith('apps/')) continue;
        const dst = '/' + name.split('/').pop();
        if (name.endsWith('.exe')) MemoryFileSystem.writeBytes(dst, os.readBundleBytes(name));
        else if (name.endsWith('.sys')) MemoryFileSystem.writeBytes(dst, os.readBundleBytes(name));
        else MemoryFileSystem.write(dst, os.readBundleText(name));
    }
}

// namespace de objetos estilo NT + drivers com DriverEntry (I/O Manager):
// \FS = MemoryFileSystem montado, \DosDevices\C: -> \FS, \Device\* criados pelos drivers
function initObjects() {
    ObjectManager.createDirectory('\\Device');
    ObjectManager.createDirectory('\\DosDevices');
    ObjectManager.mount('\\FS', MemoryFileSystem);
    ObjectManager.createSymlink('\\DosDevices\\C:', '\\FS');

    IoManager.init();                                    // \Driver
    require('drivers/console/console').DriverEntry(IoManager);
    require('drivers/input/keyboard').DriverEntry(IoManager);

    // NTFS: disco slave IDE vira D: (se presente)
    if (AtaPio.present(1)) {
        try {
            const ntfs = require('ntos/fs/ntfs').mount(1);
            ObjectManager.mount('\\NTFS', ntfs);
            ObjectManager.createSymlink('\\DosDevices\\D:', '\\NTFS');
            os.debugPrint('[boot] NTFS montado em D:');
        } catch (e) {
            os.debugPrint('[boot] NTFS falhou: ' + e.message);
        }
    }
}

// servico de teclado: processo que le a IRQ1 (ring) e publica no canal 'kbd'
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
    Interrupts.init();                  // IDT+PIC+PIT construidos em JS; IRQs ligadas
    seedVfs();
    initObjects();

    os.debugPrint('KERNEL_JS_OK');      // kernel JS montado e executando
    SelfTest.run();                // imprime SELFTEST_OK

    // processos: servico de teclado (IPC) + shell
    Scheduler.spawn('kbd-service', KbdService);
    Scheduler.spawn('shell', Shell.main);
    os.debugPrint('[kernel] idle loop - escalonador cooperativo ativo');
    for (;;) Scheduler.tick();
}

kmain();
