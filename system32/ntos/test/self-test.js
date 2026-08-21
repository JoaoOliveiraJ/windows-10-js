// ===========================================================================
// jsOS - system32/ntos/test/selftest.js: exercita MemoryFileSystem, syscalls, escalonador,
// Object Manager e o loader PeLoader sem teclado. Imprime SELFTEST_OK no serial.
// ===========================================================================

const MemoryFileSystem = require('ntos/fs/memory-file-system');
const SystemCall = require('ntos/ex/syscalls');
const Scheduler = require('ntos/ps/scheduler');
const ObjectManager = require('ntos/ob/object-manager');
const IoManager = require('ntos/io/io-manager');
const Interrupts = require('nano/interrupts');
const MessageChannels = require('nano/message-channels');
const NanoKernel = require('nano/kernel');
const PeLoader = require('win32/pe-loader');
const Win32 = require('win32/win32');
const Ntoskrnl = require('win32/ntoskrnl');

function assert(cond, msg) {
    if (!cond) {
        os.debugPrint('SELFTEST FALHOU: ' + msg);
        os.halt();
    }
}

function run() {
    // MemoryFileSystem
    MemoryFileSystem.write('/tmp/a.txt', 'hello jsOS');
    assert(MemoryFileSystem.read('/tmp/a.txt') === 'hello jsOS', 'vfs read/write');
    assert(MemoryFileSystem.exists('/tmp/a.txt'), 'vfs exists');
    assert(MemoryFileSystem.size('/tmp/a.txt') === 10, 'vfs size');
    MemoryFileSystem.remove('/tmp/a.txt');
    assert(!MemoryFileSystem.exists('/tmp/a.txt'), 'vfs remove');

    // syscalls por numero
    SystemCall(SystemCall.byName.write, '/tmp/b.js', 'return 21 * 2');
    assert(SystemCall(SystemCall.byName.exists, '/tmp/b.js'), 'sys write');
    assert(SystemCall(SystemCall.byName.read, '/tmp/b.js') === 'return 21 * 2', 'sys read');

    // executa "programa" JS do MemoryFileSystem com a API de syscall
    const prog = new Function('SystemCall', SystemCall(SystemCall.byName.read, '/tmp/b.js'));
    assert(prog(SystemCall) === 42, 'exec programa JS do MemoryFileSystem');

    // memoria
    const m = SystemCall(SystemCall.byName.meminfo);
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
    const h1 = ObjectManager.open('\\FS\\README');
    assert(h1 > 0, 'objmgr open arquivo via \\FS');
    const h2 = ObjectManager.open('\\fs\\readme');   // case-insensitive como NT
    assert(h2 > 0, 'objmgr case-insensitive');
    assert(ObjectManager.close(h1), 'objmgr close');
    assert(ObjectManager.open('\\Device\\Console') > 0, 'objmgr device');
    assert(ObjectManager.open('\\Device\\NaoExiste') === 0, 'objmgr negativo');
    assert(SystemCall(SystemCall.byName.open, '\\Device\\Keyboard') > 0, 'sys open');
    // link simbolico \DosDevices\C: -> \FS (como no Windows)
    assert(ObjectManager.open('\\DosDevices\\C:\\README') > 0, 'objmgr symlink C:');

    // I/O Manager: drivers registrados + IRP de escrita no console
    assert(ObjectManager.lookup('\\Driver\\Console'), 'iom driver console');
    assert(ObjectManager.lookup('\\Driver\\Keyboard'), 'iom driver teclado');
    const irpOk = IoManager.write('\\Device\\Console', '');
    assert(irpOk.status === IoManager.STATUS.SUCCESS, 'iom IRP write console');
    const irpBad = IoManager.write('\\Device\\NaoExiste', 'x');
    assert(irpBad.status === IoManager.STATUS.NOT_FOUND, 'iom IRP dispositivo inexistente');

    // NTFS: monta o disco slave IDE, lista a raiz e le HELLO.TXT de verdade
    const Ntfs = require('ntos/fs/ntfs');
    const ntfs = Ntfs.mount(1);
    assert(ntfs.exists('/HELLO.TXT'), 'ntfs existe');
    assert(ntfs.list().indexOf('/HELLO.TXT') >= 0, 'ntfs list');
    assert(ntfs.read('/HELLO.TXT').indexOf('jsOS') >= 0, 'ntfs read');
    assert(ObjectManager.open('\\DosDevices\\D:\\HELLO.TXT') > 0, 'ntfs via D:');

    // nanokernel: IRQ0/LAPIC timer - so onde a plataforma suporta
    if (Interrupts.isAvailable()) {
        const t0 = Interrupts.tickCount();
        let spins = 0;
        while (Interrupts.tickCount() === t0 && spins < 100000000) spins++;
        assert(Interrupts.tickCount() > t0, 'timer disparando (IDT em JS)');
    } else {
        os.debugPrint('[selftest] plataforma sem IRQ (WHPX) - tick test pulado');
    }

    // nanokernel: IPC por canal nomeado
    MessageChannels.createChannel('teste');
    MessageChannels.send('teste', 42);
    assert(MessageChannels.receive('teste') === 42, 'ipc send/receive');
    assert(MessageChannels.receive('teste') === null, 'ipc canal vazio');

    // nanokernel: registro e chamada de servico
    NanoKernel.registerService('eco', req => req);
    assert(NanoKernel.callService('eco', 7) === 7, 'nano servico eco');

    // PeLoader: executa hello.exe (Windows, x86-64) nativo no bare metal
    const exe = MemoryFileSystem.readBytes('/hello.exe');
    assert(exe, 'hello.exe no MemoryFileSystem');
    const entry = PeLoader.load(exe);
    os.execMachineCode(entry);
    assert(Win32.lastWrite.indexOf('jsOS') >= 0, 'exe chamou kernel32 WriteFile');

    // driver nativo .sys (estilo WDM): PE loader + exports ntoskrnl em JS
    Ntoskrnl.loadDriver('/echo.sys');
    assert(ObjectManager.lookup('\\Device\\Echo'), 'driver criou \\Device\\Echo');
    assert(ObjectManager.lookup('\\DosDevices\\Echo'), 'driver criou link simbolico');
    const writeRequest = IoManager.write('\\Device\\Echo', 'eco-nativo');
    assert(writeRequest.status === IoManager.STATUS.SUCCESS, 'IRP write nativo');
    assert(writeRequest.info === 10, 'driver nativo reportou 10 bytes escritos');
    const readRequest = IoManager.read('\\Device\\Echo');
    assert(readRequest.result === 'eco-nativo', 'driver nativo devolveu o eco');

    // grupo 2: ciclo de vida de IRP (IoAllocateIrp/IoCompleteRequest/IoFreeIrp)
    // helper: carrega um driver nativo, le do device, confere a resposta
    function testNativeDriver(file, device, expected) {
        Ntoskrnl.loadDriver(file);
        assert(ObjectManager.lookup(device), 'device de ' + file);
        const response = IoManager.read(device);
        assert(response.result === expected,
               'read de ' + file + ' -> "' + response.result + '"');
    }
    testNativeDriver('/irplife.sys', '\\Device\\IrpLife', 'irp-life-ok');

    // grupo 3: Rtl unicode strings (Compare/Copy/Equal)
    testNativeDriver('/rtlstr.sys', '\\Device\\RtlStr', 'rtl-str-ok');

    // grupo 4: Ke tempo (KeQuerySystemTime/KeQueryTickCount)
    testNativeDriver('/ketime.sys', '\\Device\\KeTime', 'ke-time-ok');

    // grupo 5: Mm memoria (MmAllocateNonCachedMemory/MmFreeNonCachedMemory)
    testNativeDriver('/mmmem.sys', '\\Device\\MmMem', 'mm-mem-ok');

    // grupo 6: Ex pool (ExAllocatePoolWithTag/ExFreePool) + IoDeleteDevice
    testNativeDriver('/expool.sys', '\\Device\\ExPool', 'ex-pool-ok');
    assert(!ObjectManager.lookup('\\Device\\ExPoolTrash'),
           'IoDeleteDevice removeu o device do namespace');

    // grupo 7: ciclo de vida — unload real (DriverUnload + IoDeleteSymbolicLink)
    Ntoskrnl.loadDriver('/lifecycle.sys');
    assert(ObjectManager.lookup('\\Device\\LifeCycle'), 'lifecycle device criado');
    assert(ObjectManager.lookup('\\DosDevices\\LifeCycle'), 'lifecycle link criado');
    assert(Ntoskrnl.unloadDriver('lifecycle'), 'unloadDriver');
    assert(!ObjectManager.lookup('\\Device\\LifeCycle'),
           'device removido no unload');
    assert(!ObjectManager.lookup('\\Driver\\lifecycle'),
           'driver removido do namespace');
    assert(!ObjectManager.lookup('\\DosDevices\\LifeCycle'),
           'DriverUnload rodou e removeu o link');

    // grupo 8: Interlocked* atomicas
    testNativeDriver('/interlock.sys', '\\Device\\Interlock', 'interlock-ok');

    // grupo 9: IRQL + spinlock (KeRaiseIrql/KeAcquireSpinLockRaiseToDpc...)
    testNativeDriver('/irql.sys', '\\Device\\Irql', 'irql-ok');

    os.debugPrint('SELFTEST_OK');
}

module.exports = { run };
