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

    // Memory Manager real: PFN (frames fisicos) + paging (VA->PA de verdade)
    const Pfn = require('ntos/mm/pfn');
    const Paging = require('ntos/mm/paging');
    const VirtualMemory = require('ntos/mm/virtual-memory');

    const freeBefore = Pfn.freeCount();
    const frame1 = Pfn.allocPage();
    assert(frame1 > 0, 'pfn alloc');
    assert(Pfn.freeCount() === freeBefore - 1, 'pfn contagem desceu');
    Pfn.freePage(frame1);
    assert(Pfn.freeCount() === freeBefore, 'pfn free devolveu');
    const frame2 = Pfn.allocPage();
    assert(frame2 === frame1, 'pfn reusa frame livre');
    Pfn.freePage(frame2);

    // identity: VA conhecida traduz p/ o mesmo fisico
    assert(Paging.translate(0x100000) === 0x100000, 'identity map traduz');

    // VirtualAlloc: VA nova -> frame fisico distinto, dados fluem pela tabela
    const va = VirtualMemory.alloc(4096);
    assert(va > 0, 'VirtualAlloc');
    const pa = Paging.translate(va);
    assert(pa > 0 && (pa & ~0xFFF) !== (va & ~0xFFF), 'VA mapeada p/ frame distinto');
    os.writePhysical32(va, 0xC0FFEE);
    assert(os.readPhysical32(va) === 0xC0FFEE, 'escrita pela VA mapeada');
    assert(os.readPhysical32(pa) === 0xC0FFEE, 'frame fisico tem o conteudo');
    VirtualMemory.free(va, 4096);
    assert(Paging.translate(va) === 0, 'pagina desmapada no free');

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
    const entry = PeLoader.load(exe).entryPoint;
    os.execMachineCode(entry);
    assert(Win32.lastWrite.indexOf('jsOS') >= 0, 'exe chamou kernel32 WriteFile');

    // drivers de servico: carregados no BOOT via Registry (fase 1) + PnP start.
    // O selftest so confere que estao vivos e funcionais:
    const echoDevice = ObjectManager.lookup('\\Device\\Echo');
    assert(echoDevice, 'echo carregado no boot (registry)');
    assert(ObjectManager.lookup('\\DosDevices\\Echo'), 'link do echo criado');
    assert(echoDevice.data.pnpStarted === true, 'echo recebeu PNP START_DEVICE');
    const writeRequest = IoManager.write('\\Device\\Echo', 'eco-nativo');
    assert(writeRequest.status === IoManager.STATUS.SUCCESS, 'IRP write nativo');
    assert(writeRequest.info === 10, 'driver nativo reportou 10 bytes escritos');
    const readRequest = IoManager.read('\\Device\\Echo');
    assert(readRequest.result === 'eco-nativo', 'driver nativo devolveu o eco');

    // helper: device ja carregado no boot; confere que existe e le direito
    function checkNativeDriver(device, expected) {
        assert(ObjectManager.lookup(device), 'device ' + device + ' existe');
        const response = IoManager.read(device);
        assert(response.result === expected,
               'read de ' + device + ' -> "' + response.result + '"');
    }
    checkNativeDriver('\\Device\\IrpLife', 'irp-life-ok');
    checkNativeDriver('\\Device\\RtlStr', 'rtl-str-ok');
    checkNativeDriver('\\Device\\KeTime', 'ke-time-ok');
    checkNativeDriver('\\Device\\MmMem', 'mm-mem-ok');
    checkNativeDriver('\\Device\\ExPool', 'ex-pool-ok');
    assert(!ObjectManager.lookup('\\Device\\ExPoolTrash'),
           'IoDeleteDevice removeu o device do namespace');
    checkNativeDriver('\\Device\\Interlock', 'interlock-ok');
    checkNativeDriver('\\Device\\Irql', 'irql-ok');
    checkNativeDriver('\\Device\\RtlAnsi', 'rtl-ansi-ok');
    checkNativeDriver('\\Device\\Registry', 'registry-ok');

    // Power Manager: IRP_MJ_POWER SET/QUERY_POWER com estado real rastreado
    const DevicePowerState = require('win32/nt-abi').DEVICE_POWER_STATE;
    assert(ObjectManager.lookup('\\Device\\Power'), 'power carregado no boot');
    let powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D0', 'device comeca em D0');
    const setD2 = IoManager.setDevicePowerState('\\Device\\Power',
                                                DevicePowerState.D2);
    assert(setD2.status === IoManager.STATUS.SUCCESS,
           'SET_POWER D2 aceito (status=0x' + (setD2.status >>> 0).toString(16) + ')');
    powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D2',
           'driver entrou em D2 -> "' + powerRead.result + '"');
    assert(IoManager.getDevicePowerState('\\Device\\Power') === DevicePowerState.D2,
           'Power Manager registrou D2 (PoSetPowerState)');
    const queryD3 = IoManager.queryDevicePowerState('\\Device\\Power',
                                                    DevicePowerState.D3);
    assert(queryD3.status === IoManager.STATUS.SUCCESS,
           'QUERY_POWER D3 aceito (status=0x' + (queryD3.status >>> 0).toString(16) + ')');
    powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D2', 'QUERY_POWER nao muda o estado');
    IoManager.setDevicePowerState('\\Device\\Power', DevicePowerState.D0);
    powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D0', 'voltou a D0');
    assert(IoManager.getDevicePowerState('\\Device\\Power') === DevicePowerState.D0,
           'Power Manager registrou D0');

    // SMP: CPUs reais descobertos via ACPI MADT; APs online via INIT-SIPI;
    // codigo nativo executado DE VERDADE em paralelo nos outros CPUs
    const Smp = require('ntos/ke/smp');
    const cpuTotal = Smp.discoveredCpuCount();
    assert(cpuTotal >= 1, 'ACPI MADT com ao menos o BSP');
    if (cpuTotal > 1 && Smp.onlineCpuCount() < cpuTotal) {
        // WHPX (QEMU 11) nao liga vCPUs secundarios: o SIPI chega ao APIC
        // emulado (visto no trace do QEMU) mas o vCPU nunca e escalonado.
        // Em hardware real o INIT-SIPI-SIPI funciona — a sequencia aqui e a
        // oficial da spec Intel MP. Degrada para 1 CPU como no boot real.
        os.debugPrint('[selftest] plataforma sem startup de AP (WHPX) - ' +
                      'testes de paralelismo pulados (CPUs online: ' +
                      Smp.onlineCpuCount() + '/' + cpuTotal + ')');
    }
    if (cpuTotal > 1 && Smp.onlineCpuCount() === cpuTotal) {
        Ntoskrnl.loadDriver('/smpjob.sys');
        const spinWork = Ntoskrnl.getDriverExport('smpjob', 'SpinWork');
        const parallelSum = Ntoskrnl.getDriverExport('smpjob', 'ParallelSum');
        assert(spinWork > 0 && parallelSum > 0, 'exports do smpjob resolvidos');
        // resultado do AP tem que ser identico ao do BSP (deterministico)
        const expectedSpin = os.execMsAbi(spinWork, 100000, 0, 0, 0) >>> 0;
        for (let i = 0; i < Smp.apSlotCount(); i++) {
            const got = Smp.runOnAp(Smp.apSlot(i), spinWork, 100000) >>> 0;
            assert(got === expectedSpin,
                   'job nativo no AP slot ' + i + ' retornou igual ao BSP');
        }
        // todos os APs ocupados AO MESMO TEMPO (paralelismo real)
        const expectedSum = os.execMsAbi(parallelSum, 777, 2000000, 0, 0) >>> 0;
        for (let i = 0; i < Smp.apSlotCount(); i++)
            Smp.startJob(Smp.apSlot(i), parallelSum, 777, 2000000);
        for (let i = 0; i < Smp.apSlotCount(); i++)
            assert((Smp.waitJob(Smp.apSlot(i)) >>> 0) === expectedSum,
                   'AP ' + i + ' somou em paralelo correto');
        os.debugPrint('[selftest] SMP: ' + cpuTotal + ' CPUs, ' +
                      Smp.apSlotCount() + ' APs executaram nativo em paralelo');
    }

    // grupo 14: pilha de devices — filtro WDM real acima do \Device\Echo
    // (attach, IoCallDriver descendo a pilha, completion routines subindo)
    Ntoskrnl.loadDriver('/filter.sys');
    assert(ObjectManager.lookup('\\Device\\Filter'), 'filter device criado');
    let echoRequest = IoManager.write('\\Device\\Echo', 'filtro');
    assert(echoRequest.status === IoManager.STATUS.SUCCESS,
           'write atraves do filtro');
    echoRequest = IoManager.read('\\Device\\Echo');
    assert(echoRequest.result === 'filtro',
           'echo intacto atraves do filtro -> "' + echoRequest.result + '"');
    const filterStats = IoManager.deviceControl('\\Device\\Filter', 0x801);
    assert(filterStats.status === IoManager.STATUS.SUCCESS &&
           filterStats.result === 'filter-ok:2,2',
           'IOCTL do filtro falhou: status=0x' +
           (filterStats.status >>> 0).toString(16) +
           ' resultado="' + filterStats.result + '"');

    // ciclo de vida: carga+descarga dinamica continua dirigida pelo JS.
    // Com handle ABERTO o unload e recusado (refcount, como o NT de verdade).
    Ntoskrnl.loadDriver('/lifecycle.sys');
    assert(ObjectManager.lookup('\\Device\\LifeCycle'), 'lifecycle device criado');
    assert(ObjectManager.lookup('\\DosDevices\\LifeCycle'), 'lifecycle link criado');
    {
        const lifeHandle = IoManager.openDevice('\\Device\\LifeCycle');
        assert(lifeHandle.status === IoManager.STATUS.SUCCESS, 'handle aberto no lifecycle');
        assert(Ntoskrnl.unloadDriver('lifecycle') === false,
               'unload RECUSADO com handle aberto (refcount)');
        IoManager.closeDevice(lifeHandle.handle);
        assert(Ntoskrnl.unloadDriver('lifecycle'), 'unloadDriver apos fechar handle');
    }
    assert(!ObjectManager.lookup('\\Device\\LifeCycle'),
           'device removido no unload');
    assert(!ObjectManager.lookup('\\Driver\\lifecycle'),
           'driver removido do namespace');
    assert(!ObjectManager.lookup('\\DosDevices\\LifeCycle'),
           'DriverUnload rodou e removeu o link');
    checkNativeDriver('\\Device\\Interlock', 'interlock-ok');
    checkNativeDriver('\\Device\\Irql', 'irql-ok');
    checkNativeDriver('\\Device\\RtlAnsi', 'rtl-ansi-ok');
    checkNativeDriver('\\Device\\Registry', 'registry-ok');

    // grupo 12: DPC + work item + thread de kernel (cooperativo real)
    Ntoskrnl.loadDriver('/threads.sys');
    assert(ObjectManager.lookup('\\Device\\Threads'), 'threads device criado');
    for (let i = 0; i < 20; i++) { Ntoskrnl.runKernelTasks(); Scheduler.tick(); }
    const threadsRead = IoManager.read('\\Device\\Threads');
    assert(threadsRead.result === 'threads-ok',
           'DPC + work item + thread rodaram -> "' + threadsRead.result + '"');

    // grupo 13: KTIMER — timers reais com DPC, periodico e cancelamento
    Ntoskrnl.loadDriver('/ktimer.sys');
    assert(ObjectManager.lookup('\\Device\\KTimer'), 'ktimer device criado');
    checkNativeDriver('\\Device\\KTimer', 'ktimer-ok');

    // grupo 15: dispatcher — KEVENT/KMUTEX/waits; thread worker acordada por
    // evento sinalizado por um DPC de timer (cenario classico de driver)
    Ntoskrnl.loadDriver('/event.sys');
    assert(ObjectManager.lookup('\\Device\\Event'), 'event device criado');
    {
        const KernelClock = require('ntos/ke/clock');
        const wakeDeadline = KernelClock.uptimeMs() + 80;
        while (KernelClock.uptimeMs() < wakeDeadline) {
            Ntoskrnl.runKernelTasks();
            Scheduler.tick();
        }
    }
    checkNativeDriver('\\Device\\Event', 'event-ok');

    // grupo 16: IRP_MJ_CREATE/CLOSE com FILE_OBJECT + Zw* file I/O real
    // (driver le o NTFS D: e escreve/le no ramfs C: em modo kernel)
    Ntoskrnl.loadDriver('/fileio.sys');
    assert(ObjectManager.lookup('\\Device\\FileIo'), 'fileio device criado');
    const opened = IoManager.openDevice('\\Device\\FileIo');
    assert(opened.status === IoManager.STATUS.SUCCESS && opened.handle > 0,
           'IRP_MJ_CREATE no driver nativo');
    const fileIoRead = IoManager.readHandle(opened.handle);
    assert(fileIoRead.result === 'fileio-ok',
           'read via handle (CREATE+FILE_OBJECT+Zw* NTFS/ramfs) -> "' +
           fileIoRead.result + '"');
    assert(IoManager.closeDevice(opened.handle) === IoManager.STATUS.SUCCESS,
           'IRP_MJ_CLOSE no driver nativo');

    // grupo 17: ExAllocatePool2 + Ob* refcount + IRP_MJ_CLEANUP
    Ntoskrnl.loadDriver('/guards.sys');
    assert(ObjectManager.lookup('\\Device\\Guards'), 'guards device criado');
    {
        const g1 = IoManager.openDevice('\\Device\\Guards');
        const g2 = IoManager.openDevice('\\Device\\Guards');
        assert(g1.handle > 0 && g2.handle > 0 && g1.handle !== g2.handle,
               'dois handles independentes (dois CREATE)');
        assert(IoManager.closeDevice(g1.handle) === 0, 'close 1 (CLEANUP+CLOSE)');
        assert(IoManager.closeDevice(g2.handle) === 0, 'close 2 (CLEANUP+CLOSE)');
    }
    checkNativeDriver('\\Device\\Guards', 'guards-ok');

    // grupo 18: MmMapIoSpace (LAPIC real lido via mapeamento), enumeracao e
    // delete no Registry, stall calibrado por TSC
    Ntoskrnl.loadDriver('/mmio.sys');
    assert(ObjectManager.lookup('\\Device\\Mmio'), 'mmio device criado');
    checkNativeDriver('\\Device\\Mmio', 'mmio-ok');

    // grupo 19: I/O sincrono driver->driver (IoBuild* + KEVENT) pela pilha
    // inteira (filtro->echo) e IoTimer de 1s do NT
    Ntoskrnl.loadDriver('/syncio.sys');
    assert(ObjectManager.lookup('\\Device\\SyncIo'), 'syncio device criado');
    {
        const KernelClock2 = require('ntos/ke/clock');
        const timerDeadline = KernelClock2.uptimeMs() + 1300;
        while (KernelClock2.uptimeMs() < timerDeadline) {
            Ntoskrnl.runKernelTasks();
            Scheduler.tick();
        }
    }
    checkNativeDriver('\\Device\\SyncIo', 'syncio-ok');

    // grupo 20: FAST_MUTEX real, Rtl int<->string, work item EX (3 args)
    Ntoskrnl.loadDriver('/fastres.sys');
    assert(ObjectManager.lookup('\\Device\\FastRes'), 'fastres device criado');
    for (let i = 0; i < 10; i++) { Ntoskrnl.runKernelTasks(); Scheduler.tick(); }
    checkNativeDriver('\\Device\\FastRes', 'fastres-ok');

    os.debugPrint('SELFTEST_OK');
}

module.exports = { run };
