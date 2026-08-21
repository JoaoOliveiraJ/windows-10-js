// ===========================================================================
// jsOS - system32/ntos/test/selftest.js: exercita VFS, syscalls, escalonador,
// Object Manager e o loader PE sem teclado. Imprime SELFTEST_OK no serial.
// ===========================================================================

const VFS = require('ntos/fs/vfs');
const SYS = require('ntos/ex/syscalls');
const Scheduler = require('ntos/ps/scheduler');
const ObjMgr = require('ntos/ob/objmgr');
const PE = require('win32/pe');
const Win32 = require('win32/win32');

function assert(cond, msg) {
    if (!cond) {
        os.print('SELFTEST FALHOU: ' + msg);
        os.halt();
    }
}

function run() {
    // VFS
    VFS.write('/tmp/a.txt', 'hello jsOS');
    assert(VFS.read('/tmp/a.txt') === 'hello jsOS', 'vfs read/write');
    assert(VFS.exists('/tmp/a.txt'), 'vfs exists');
    assert(VFS.size('/tmp/a.txt') === 10, 'vfs size');
    VFS.remove('/tmp/a.txt');
    assert(!VFS.exists('/tmp/a.txt'), 'vfs remove');

    // syscalls por numero
    SYS(SYS.byName.write, '/tmp/b.js', 'return 21 * 2');
    assert(SYS(SYS.byName.exists, '/tmp/b.js'), 'sys write');
    assert(SYS(SYS.byName.read, '/tmp/b.js') === 'return 21 * 2', 'sys read');

    // executa "programa" JS do VFS com a API de syscall
    const prog = new Function('SYS', SYS(SYS.byName.read, '/tmp/b.js'));
    assert(prog(SYS) === 42, 'exec programa JS do VFS');

    // memoria
    const m = SYS(SYS.byName.meminfo);
    assert(m.total > 0 && m.used > 0, 'meminfo');

    // escalonador: processo gerador cooperativo
    let ran = 0;
    Scheduler.spawn('test', function* () { ran++; yield; ran++; });
    Scheduler.tick();                    // roda ate o yield   (ran=1)
    assert(ran === 1, 'sched passo 1');
    Scheduler.tick();                    // termina            (ran=2, done)
    assert(ran === 2, 'sched passo 2');
    assert(Scheduler.count() === 0, 'sched reap');

    // Object Manager: namespace, handles, refcount, FS montado
    const h1 = ObjMgr.open('\\FS\\README');
    assert(h1 > 0, 'objmgr open arquivo via \\FS');
    const h2 = ObjMgr.open('\\fs\\readme');   // case-insensitive como NT
    assert(h2 > 0, 'objmgr case-insensitive');
    assert(ObjMgr.close(h1), 'objmgr close');
    assert(ObjMgr.open('\\Device\\Console') > 0, 'objmgr device');
    assert(ObjMgr.open('\\Device\\NaoExiste') === 0, 'objmgr negativo');
    assert(SYS(SYS.byName.open, '\\Device\\Keyboard') > 0, 'sys open');
    // link simbolico \DosDevices\C: -> \FS (como no Windows)
    assert(ObjMgr.open('\\DosDevices\\C:\\README') > 0, 'objmgr symlink C:');

    // PE: executa hello.exe (Windows, x86-64) nativo no bare metal
    const exe = VFS.readBytes('/hello.exe');
    assert(exe, 'hello.exe no VFS');
    const entry = PE.load(exe);
    os.execAt(entry);
    assert(Win32.lastWrite.indexOf('jsOS') >= 0, 'exe chamou kernel32 WriteFile');

    os.print('SELFTEST_OK');
}

module.exports = { run };
