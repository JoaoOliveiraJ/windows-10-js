// ===========================================================================
// jsOS - system32/main.js: ponto de entrada e raiz de composicao do kernel.
//
// Sobe o sistema de modulos (ntos/module.js) e monta o sistema operacional
// inteiro em JavaScript com require(): drivers, ntos, win32, shell.
// A camada C (hal/) so oferece as primitivas os.* (engine + I/O crua).
// ===========================================================================

// unico eval direto: o bootstrap dos modulos
(function bootstrap() {
    const src = os.readFile('system32/ntos/rtl/module.js');
    if (src === null) { os.print('FALTA system32/ntos/rtl/module.js no bundle'); os.halt(); }
    (0, eval)(src + '\n//# sourceURL=system32/ntos/rtl/module.js');
})();

const require = JSOS.require;

globalThis.Kernel = { VERSION: '0.5.0' };

// ---- monta o sistema (cada subsistema e um modulo exportavel) ----
const VGA       = require('drivers/video/vga');
const Console   = require('drivers/console/console');
const VFS       = require('ntos/fs/vfs');
const Scheduler = require('ntos/ps/scheduler');
const SelfTest  = require('ntos/test/selftest');
const ObjMgr    = require('ntos/ob/objmgr');
const Keyboard  = require('drivers/input/keyboard');
const Shell     = require('shell/shell');
require('ntos/ex/syscalls');    // registra a tabela SYS
require('win32/win32');         // registra globalThis.Win32 (handler p/ o C)
require('win32/pe');            // loader PE disponivel p/ shell/selftest

function banner() {
    Console.print('=================================================');
    Console.print(' jsOS v' + Kernel.VERSION + ' - kernel 100% JavaScript');
    Console.print(' bare metal x86-64 (BIOS real mode -> long mode)');
    Console.print(' RAM: ' + Math.floor(os.ramSize() / 1048576) + ' MB');
    Console.print('=================================================');
}

function seedVfs() {
    // todo arquivo de apps/ vira arquivo do VFS ( /<nome> )
    for (const name of os.listBundle()) {
        if (!name.startsWith('apps/')) continue;
        const dst = '/' + name.slice(5);
        if (name.endsWith('.exe')) VFS.writeBytes(dst, os.readFileBytes(name));
        else VFS.write(dst, os.readFile(name));
    }
}

// namespace de objetos estilo NT: \FS = VFS montado, \Device\* = dispositivos,
// \DosDevices\C: = link simbolico p/ \FS (como no Windows)
function initObjects() {
    ObjMgr.createDirectory('\\Device');
    ObjMgr.createDirectory('\\DosDevices');
    ObjMgr.mount('\\FS', VFS);
    ObjMgr.createObject('\\Device', 'Console', 'Device', { write: s => Console.write(s) });
    ObjMgr.createObject('\\Device', 'Keyboard', 'Device', { read: () => Keyboard.readKey() });
    ObjMgr.createSymlink('\\DosDevices\\C:', '\\FS');
}

function kmain() {
    VGA.clear();
    banner();
    seedVfs();
    initObjects();

    os.print('KERNEL_JS_OK');      // kernel JS montado e executando
    SelfTest.run();                // imprime SELFTEST_OK

    // sobe o shell como processo 1 e entra no loop do kernel
    Scheduler.spawn('shell', Shell.main);
    os.print('[kernel] idle loop - escalonador cooperativo ativo');
    for (;;) Scheduler.tick();
}

kmain();
