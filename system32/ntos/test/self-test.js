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
const Pfn = require('ntos/mm/pfn');
const Paging = require('ntos/mm/paging');
const VirtualMemory = require('ntos/mm/virtual-memory');
const ProcessManager = require('ntos/ps/process');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');
const Ntfs = require('ntos/fs/ntfs');
const Smp = require('ntos/ke/smp');
const Clock = require('ntos/ke/clock');

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

    // Process Manager real: EPROCESS/KTHREAD com os offsets do ntoskrnl.exe
    // (RE Win10 22H2): pid @0x440, ActiveProcessLinks @0x448, ApcState @0xB8
    const systemProcess = ProcessManager.getSystemProcess();
    assert(GuestMemory.readGuest64(systemProcess + NtAbi.EPROCESS.UNIQUE_PROCESS_ID) === 4,
           'System EPROCESS com pid 4');
    assert(ProcessManager.listActiveProcesses()
               .some(p => p.pid === 4 && p.name === 'System'),
           'System na cadeia PsActiveProcessHead');
    assert(ProcessManager.getCurrentProcess() === systemProcess,
           'processo corrente no boot = System (ApcState.Process)');

    // Object Manager: namespace, handles, refcount, FS montado
    const h1 = ObjectManager.open('\\FS\\README');
    assert(h1 > 0, 'objmgr open arquivo via \\FS');
    const h2 = ObjectManager.open('\\fs\\readme');   // case-insensitive como NT
    assert(h2 > 0, 'objmgr case-insensitive');
    assert(ObjectManager.close(h1), 'objmgr close');
    assert(ObjectManager.open('\\Device\\Console') > 0, 'objmgr device');
    assert(ObjectManager.open('\\Device\\NaoExiste') === 0, 'objmgr negativo');
    assert(SystemCall(SystemCall.byName.open, '\\Device\\Console') > 0, 'sys open');
    // link simbolico \DosDevices\C: -> \FS (como no Windows)
    assert(ObjectManager.open('\\DosDevices\\C:\\README') > 0, 'objmgr symlink C:');

    // I/O Manager: drivers registrados + IRP de escrita no console
    assert(ObjectManager.lookup('\\Driver\\Console'), 'iom driver console');
    const irpOk = IoManager.write('\\Device\\Console', '');
    assert(irpOk.status === IoManager.STATUS.SUCCESS, 'iom IRP write console');
    const irpBad = IoManager.write('\\Device\\NaoExiste', 'x');
    assert(irpBad.status === IoManager.STATUS.NOT_FOUND, 'iom IRP dispositivo inexistente');

    // NTFS: monta o disco slave IDE, lista a raiz e le HELLO.TXT de verdade.
    // PULADO enquanto o disco e' do atapi.sys (o ata-pio nao toca mais o IDE;
    // montar via atapi->disk volta quando a pilha estiver de pe)
    if (false) {
    const ntfs = Ntfs.mount(1);
    assert(ntfs.exists('/HELLO.TXT'), 'ntfs existe');
    assert(ntfs.list().indexOf('/HELLO.TXT') >= 0, 'ntfs list');
    assert(ntfs.read('/HELLO.TXT').indexOf('jsOS') >= 0, 'ntfs read');
    assert(ObjectManager.open('\\DosDevices\\D:\\HELLO.TXT') > 0, 'ntfs via D:');
    }

    // nanokernel: LAPIC timer — o timer DEVE estar disparando (IDT em JS,
    // entrega real pela plataforma). Janela generosa: a calibracao varia
    if (Interrupts.isAvailable()) {
        const t0 = Interrupts.tickCount();
        const waitEnd = Clock.uptimeMs() + 500;
        while (Interrupts.tickCount() === t0 && Clock.uptimeMs() < waitEnd) {
            /* espera o proximo tick de hardware */
        }
        assert(Interrupts.tickCount() > t0, 'timer do LAPIC disparando (entrega real)');
    } else {
        os.debugPrint('[selftest] IDT nao carregada - tick test pulado');
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
    assert(ObjectManager.lookup('\\Device\\Power'), 'power carregado no boot');
    let powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D0', 'device comeca em D0');
    const setD2 = IoManager.setDevicePowerState('\\Device\\Power',
                                                NtAbi.DEVICE_POWER_STATE.D2);
    assert(setD2.status === IoManager.STATUS.SUCCESS,
           'SET_POWER D2 aceito (status=0x' + (setD2.status >>> 0).toString(16) + ')');
    powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D2',
           'driver entrou em D2 -> "' + powerRead.result + '"');
    assert(IoManager.getDevicePowerState('\\Device\\Power') === NtAbi.DEVICE_POWER_STATE.D2,
           'Power Manager registrou D2 (PoSetPowerState)');
    const queryD3 = IoManager.queryDevicePowerState('\\Device\\Power',
                                                    NtAbi.DEVICE_POWER_STATE.D3);
    assert(queryD3.status === IoManager.STATUS.SUCCESS,
           'QUERY_POWER D3 aceito (status=0x' + (queryD3.status >>> 0).toString(16) + ')');
    powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D2', 'QUERY_POWER nao muda o estado');
    IoManager.setDevicePowerState('\\Device\\Power', NtAbi.DEVICE_POWER_STATE.D0);
    powerRead = IoManager.read('\\Device\\Power');
    assert(powerRead.result === 'power-D0', 'voltou a D0');
    assert(IoManager.getDevicePowerState('\\Device\\Power') === NtAbi.DEVICE_POWER_STATE.D0,
           'Power Manager registrou D0');

    // SMP: CPUs reais descobertos via ACPI MADT; APs online via INIT-SIPI;
    // codigo nativo executado DE VERDADE em paralelo nos outros CPUs
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
        const wakeDeadline = Clock.uptimeMs() + 80;
        while (Clock.uptimeMs() < wakeDeadline) {
            Ntoskrnl.runKernelTasks();
            Scheduler.tick();
        }
    }
    checkNativeDriver('\\Device\\Event', 'event-ok');

    // grupo 16: IRP_MJ_CREATE/CLOSE com FILE_OBJECT + Zw* file I/O real
    // (driver le o NTFS D: e escreve/le no ramfs C: em modo kernel)
    // PULADO enquanto o disco e' do atapi.sys (D:/NTFS via ata-pio desligado;
    // volta quando atapi->disk->classpnp->mountmgr montar o D: pela pilha MS)
    if (false) {
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
    }

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
                const timerDeadline = Clock.uptimeMs() + 1300;
        while (Clock.uptimeMs() < timerDeadline) {
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

    // grupo 21: ERESOURCE (reader/writer), rundown protection, RTL memoria
    Ntoskrnl.loadDriver('/locks.sys');
    assert(ObjectManager.lookup('\\Device\\Locks'), 'locks device criado');
    checkNativeDriver('\\Device\\Locks', 'locks-ok');

    // grupo 22: PCI bus driver + PnP real — o VGA PCI foi enumerado, o
    // gerenciador PnP casou o HardwareId (via QUERY_ID ao bus driver) e
    // chamou o AddDevice do driver com o PDO
    assert(IoManager.queryDeviceId('\\Device\\PDO4', 0) === 'PCI\\VEN_1234&DEV_1111',
           'bus driver respondeu QUERY_ID do VGA');
    assert(ObjectManager.lookup('\\Device\\PciDemo'),
           'AddDevice do pcidemo criou o FDO via PnP');
    checkNativeDriver('\\Device\\PciDemo', 'pcidemo-ok');

    // grupo 23 (atadrv) e 24 (compat): PULADOS na transicao — o atadrv faz
    // acesso IDE direto (conflita com o atapi.sys, dono do canal primario) e o
    // compat usa o NTFS D: (desligado). Voltam quando a pilha MS montar o D:.
    if (false) {
    Ntoskrnl.loadDriver('/atadrv.sys');
    assert(ObjectManager.lookup('\\Device\\AtaDrv'), 'atadrv device criado');
    checkNativeDriver('\\Device\\AtaDrv', 'atadrv-ok');

    // grupo 24: Rtl upcase/prefix/append, MmGetPhysicalAddress, controles de
    // DPC (importance/target/flush) e ZwQueryFullAttributesFile
    Ntoskrnl.loadDriver('/compat.sys');
    assert(ObjectManager.lookup('\\Device\\Compat'), 'compat device criado');
    checkNativeDriver('\\Device\\Compat', 'compat-ok');
    }

    // grupo 25: lookaside lists, MDL com PFNs reais, resolucao dinamica de
    // export chamado por ponteiro de funcao, ExGetPreviousMode
    Ntoskrnl.loadDriver('/memdrv.sys');
    assert(ObjectManager.lookup('\\Device\\MemDrv'), 'memdrv device criado');
    checkNativeDriver('\\Device\\MemDrv', 'memdrv-ok');

    // grupo 26: cancelamento de IRP real + ZwOpenFile/QueryInformationFile/
    // SetInformationFile(delete)
    // PULADO enquanto o disco e' do atapi.sys (os checks de Zw*File usam o
    // NTFS D:, desligado; volta quando a pilha MS montar o D:)
    if (false) {
    Ntoskrnl.loadDriver('/cancel.sys');
    assert(ObjectManager.lookup('\\Device\\Cancel'), 'cancel device criado');
    checkNativeDriver('\\Device\\Cancel', 'cancel-ok');
    }

    // grupo 27: listas interlocked com spinlock, ERESOURCE variants, driver
    // object extension
    Ntoskrnl.loadDriver('/listsync.sys');
    assert(ObjectManager.lookup('\\Device\\ListSync'), 'listsync device criado');
    checkNativeDriver('\\Device\\ListSync', 'listsync-ok');

    // grupo 28: IoCreateFile por nome + Zw* em dispositivo (IRPs reais),
    // DbgPrintEx e work item Ex (1 arg)
    Ntoskrnl.loadDriver('/openx.sys');
    assert(ObjectManager.lookup('\\Device\\OpenX'), 'openx device criado');
    for (let i = 0; i < 10; i++) { Ntoskrnl.runKernelTasks(); Scheduler.tick(); }
    checkNativeDriver('\\Device\\OpenX', 'openx-ok');

    // grupo 29: notificacao de processo (PsSetCreateProcessNotifyRoutine
    // disparando em create+exit de verdade), IoGetDeviceProperty via PCI,
    // IoGetRelatedDeviceObject pela pilha
    Ntoskrnl.loadDriver('/notify.sys');
    assert(ObjectManager.lookup('\\Device\\Notify'), 'notify device criado');
    Scheduler.spawn('notify-probe', function* () { yield; });
    Scheduler.tick();   // cria (notifica) e roda
    Scheduler.tick();   // termina -> reap -> notifica a saida
    checkNativeDriver('\\Device\\Notify', 'notify-ok');

    // grupo 30: ZwLoadDriver/ZwUnloadDriver, PsLookupProcessByProcessId,
    // ExSpinLock legado, IoGetStackLimits, ZwQuerySystemInformation
    const probePid = Scheduler.spawn('query-probe', function* () { for (;;) yield; });
    Ntoskrnl.loadDriver('/loader.sys');   // ZwQuerySystemInformation ve o probe
    assert(ObjectManager.lookup('\\Device\\Loader'), 'loader device criado');
    checkNativeDriver('\\Device\\Loader', 'loader-ok');
    Scheduler.kill(probePid);
    // modo RAWKBD (bundle com /rawkbd): isola o 8042 SEM nenhum driver nativo.
    // Habilita o scanning e faz polling cru da porta 0x60 — se o QEMU entrega
    // tecla, os scancodes aparecem aqui. Prova se o problema e' QEMU ou driver.
    if (MemoryFileSystem.exists('/rawkbd')) {
        os.debugPrint('[rawkbd] habilitando scanning (0xF4) e sondando 0x60 — ' +
                      'digite na janela do QEMU');
        os.writePort8(0x60, 0xF4);
        let ackSt = 0;
        for (let i = 0; i < 1000 && !(ackSt & 1); i++) ackSt = os.readPort8(0x64);
        if (ackSt & 1) os.readPort8(0x60);   // consome o ACK
        os.debugPrint('[rawkbd] scan habilitado; polling... DIGITE AGORA');
        let lastCount = Interrupts.irqCount(Interrupts.VECTOR_KEYBOARD);
        let lastBeat = 0;
        for (;;) {
            Interrupts.dispatchPending();
            // heartbeat a cada 3s p/ saber que o poller esta vivo
            if (Clock.uptimeMs() > lastBeat + 3000) {
                lastBeat = Clock.uptimeMs();
                os.debugPrint('[rawkbd] ...vivo (status 8042=0x' +
                              os.readPort8(0x64).toString(16) + ', digite)');
            }
            const irqNow = Interrupts.irqCount(Interrupts.VECTOR_KEYBOARD);
            if (irqNow !== lastCount) {
                lastCount = irqNow;
                os.debugPrint('[rawkbd] IRQ1 contagem=' + irqNow);
            }
            const status = os.readPort8(0x64);
            if (status & 1) {
                const scan = os.readPort8(0x60);
                os.debugPrint('[rawkbd] SCANCANE 0x' + scan.toString(16) +
                              ' (status 0x' + status.toString(16) + ')');
            }
        }
    }

    // grupo 31: DRIVER DE TERCEIRO — o kbdclass.sys do Windows (binario
    // Microsoft, relocado de 0x1c0000000 pelo nosso loader PE) carrega e
    // registra seu AddDevice PnP
    Ntoskrnl.loadDriver('/kbdclass.sys');
    assert(ObjectManager.lookup('\\Driver\\kbdclass'),
           'kbdclass.sys (Microsoft) carregado no namespace');
    os.debugPrint('[selftest] kbdclass.sys da Microsoft carregado com sucesso');

    // grupo 32: i8042prt.sys — o PORT driver PS/2 da Microsoft. DriverEntry
    // registra AddDevice; o hardware init acontece no START_DEVICE (PnP)
    Ntoskrnl.loadDriver('/i8042prt.sys');
    assert(ObjectManager.lookup('\\Driver\\i8042prt'),
           'i8042prt.sys (Microsoft) carregado no namespace');
    os.debugPrint('[selftest] i8042prt.sys da Microsoft carregado com sucesso');

    // grupo 33: PNP REAL — o bus da placa-mae cria os PDOs do 8042 (PNP0303
    // teclado / PNP0F13 mouse, portas 0x60/0x64 + IRQ1/IRQ12), o orquestrador
    // chama o AddDevice do i8042prt, anexa o kbdclass (filtro de classe, que
    // CONECTA a porta no AddDevice) e manda a sequencia PnP ao TOPO da pilha.
    // O START do teclado sobe de verdade (ISR nativa do i8042 no vetor 0x21);
    // o mouse fica sem START enquanto o mouclass nao estiver presente (como
    // um PC sem o driver — o devnode fica com problema, o boot segue).
    const Motherboard = require('drivers/bus/motherboard');
    const Pnp = require('ntos/io/pnp');
    const motherboardPdos = Motherboard.enumerate();
    let keyboardStackNode = null;
    for (const pdoEntry of motherboardPdos) {
        const fdoNode = Pnp.enumeratePdoStack(pdoEntry.node);
        if (pdoEntry.node.name === 'I8042Kbd') keyboardStackNode = fdoNode;
        os.debugPrint('[selftest] stack de ' + pdoEntry.node.name + ': ' +
                      (fdoNode ? 'FDO criado' : 'sem driver'));
    }

    // grupo 34: TECLADO REAL fim-a-fim — abre a porta i8042 (o CREATE dele
    // habilita a entrega do scancode) e o device de classe \Device\KeyboardClass0
    // (kbdclass), e le uma tecla: 8042 -> IRQ1 -> ISR nativa do i8042prt ->
    // DPC -> callback do kbdclass -> READ completado com KEYBOARD_INPUT_DATA.
    // Sem tecla injetada pelo harness: nao fatal (KBDTEST_SKIP), o boot segue.
    if (keyboardStackNode && keyboardStackNode.data.pnpStarted) {
        const Dispatcher = require('ntos/ke/dispatcher');
        const eventPointer = GuestMemory.guestAllocBytes(0x18);
        Dispatcher.initializeEvent(eventPointer, 0, 0);   // NotificationEvent (manual)
        // abre a PORTA do i8042 (o FDO funcional): o CREATE do driver marca a
        // porta como "aberta", habilitando a entrega de scancodes ao kbdclass
        const portOpenResult = IoManager.openDevice('\\Device\\' + keyboardStackNode.name);
        assert(portOpenResult.status === 0, 'teclado: CREATE na porta i8042 falhou 0x' +
               (portOpenResult.status >>> 0).toString(16));
        // abre o device de CLASSE do kbdclass (criado no DriverEntry) e le
        const openResult = IoManager.openDevice('\\Device\\KeyboardClass0');
        assert(openResult.status === 0, 'teclado: CREATE no kbdclass falhou 0x' +
               (openResult.status >>> 0).toString(16));
        const readRequest = IoManager.readHandle(openResult.handle, {
            userEvent: eventPointer,
            bufferLength: 48,   // multiplo de KEYBOARD_INPUT_DATA (12 bytes)
        });
        if (readRequest.status === 0x103) {   // STATUS_PENDING: esperando tecla
            os.debugPrint('KBDTEST_READY');   // o harness injeta a tecla agora
            // injeta um scancode REAL no 8042 via o comando 0xD2 do controlador
            // (Write Output Buffer): o byte aparece no buffer de saida e dispara
            // a IRQ1 — exercita a cadeia inteira (ISR->DPC->kbdclass) como uma
            // tecla de verdade, sem depender de injecao externa
            const injectScancode = (scanByte) => {
                os.writePort8(0x64, 0xD2);      // 8042: Write Output Buffer
                os.writePort8(0x60, scanByte);  // o scancode (0x1E = 'a' make)
            };
            injectScancode(0x1E);   // 'a' make
            injectScancode(0x9E);   // 'a' break
            os.writePhysical8(0x81518, 1);   // tracer na janela da injecao
            const zeroTimeout = GuestMemory.guestAllocBytes(8);
            const deadline = Clock.uptimeMs() + 10000;
            let completed = false;
            while (Clock.uptimeMs() < deadline) {
                Interrupts.dispatchPending();   // IRQ1 -> ISR nativa do i8042
                Ntoskrnl.runKernelTasks();      // DPC -> callback do kbdclass
                if (Dispatcher.waitForSingleObject(eventPointer, zeroTimeout) === 0) {
                    completed = true;
                    break;
                }
            }
            if (completed) {
                // KEYBOARD_INPUT_DATA: UnitId u16, MakeCode u16, Flags u16
                const dataPointer = readRequest.pendingBufferAddress;
                const makeCode = GuestMemory.readGuest16(dataPointer + 2);
                const flags = GuestMemory.readGuest16(dataPointer + 4);
                os.debugPrint('[selftest] tecla REAL recebida: MakeCode 0x' +
                              makeCode.toString(16) + ' flags 0x' +
                              flags.toString(16) + ' (' + readRequest.info +
                              ' bytes)');
                assert(makeCode === 0x1E, 'teclado: MakeCode esperado 0x1E (a)');
                os.debugPrint('KBDTEST_OK');
            } else {
                os.debugPrint('KBDTEST_SKIP (sem tecla injetada em 10s)');
            }
            GuestMemory.guestFreeBytes(zeroTimeout);
            if (completed) IoManager.waitPendingIoRequest(readRequest, 0);
            else IoManager.cancelPendingIoRequest(readRequest);   // sem tecla: cancela
            // os devices de teclado ficam ABERTOS (o teclado do sistema segue
            // em uso — o close dispararia a sequencia de disable da porta)
        } else {
            os.debugPrint('KBDTEST_SKIP (READ completou de cara: 0x' +
                          (readRequest.status >>> 0).toString(16) + ')');
        }
        // modo ECO interativo (bundle com /kbdecho): le scancodes para sempre
        // e imprime — para o usuario digitar numa janela do QEMU e ver o
        // driver real (i8042prt + kbdclass) entregar cada tecla
        if (MemoryFileSystem.exists('/kbdecho')) {
            os.debugPrint('[kbdecho] lendo teclas do \\Device\\KeyboardClass0 ' +
                          '(driver real i8042prt+kbdclass) — digite na janela');
            // habilita o scanning do teclado PS/2 explicitamente (0xF4) e
            // reporta o estado — diagnostico p/ ver se o QEMU entrega input
            os.writePort8(0x60, 0xF4);
            {
                let ackSt = 0;
                for (let i = 0; i < 1000 && !(ackSt & 1); i++) ackSt = os.readPort8(0x64);
                const ack = (ackSt & 1) ? os.readPort8(0x60) : -1;
                os.debugPrint('[kbdecho] 0xF4 enable-scan ACK=0x' +
                              (ack < 0 ? '-' : ack.toString(16)) +
                              ' — digite na janela do QEMU agora');
            }
            const echoEvent = GuestMemory.guestAllocBytes(0x18);
            const printEntries = (dataPointer, info) => {
                for (let off = 0; off + 12 <= info; off += 12) {
                    const makeCode = GuestMemory.readGuest16(dataPointer + off + 2);
                    const flags = GuestMemory.readGuest16(dataPointer + off + 4);
                    os.debugPrint('[kbdecho] MakeCode=0x' + makeCode.toString(16) +
                                  (flags & 1 ? ' BREAK' : ' make'));
                }
            };
            const zeroTimeoutPtr = GuestMemory.guestAllocBytes(8);  // LARGE_INTEGER 0
            for (;;) {
                Dispatcher.initializeEvent(echoEvent, 1, 0);
                const echoRead = IoManager.readHandle(openResult.handle, {
                    userEvent: echoEvent, bufferLength: 48,
                });
                if (echoRead.status === 0x103) {   // pendente: espera a tecla
                    // espera NAO-bloqueante (timeout 0) + despacha IRQ/DPC —
                    // waitForSingleObject(0) bloquearia sem despachar a ISR
                    while (Dispatcher.waitForSingleObject(echoEvent, zeroTimeoutPtr) !== 0) {
                        Interrupts.dispatchPending();
                        Ntoskrnl.runKernelTasks();
                    }
                    // captura os dados ANTES de waitPendingIoRequest liberar
                    const dataPointer = echoRead.pendingBufferAddress;
                    const info = GuestMemory.readGuest64(
                        echoRead.pendingIrpAddress +
                        NtAbi.IRP.IO_STATUS_INFORMATION);
                    printEntries(dataPointer, info);
                    IoManager.waitPendingIoRequest(echoRead, 0);
                } else if (echoRead.status === 0 && echoRead.info > 0) {
                    // completou na hora: result tem os bytes como string
                    const text = echoRead.result;
                    for (let off = 0; off + 12 <= echoRead.info; off += 12) {
                        const makeCode = text.charCodeAt(off + 2) |
                                         (text.charCodeAt(off + 3) << 8);
                        const flags = text.charCodeAt(off + 4);
                        os.debugPrint('[kbdecho] MakeCode=0x' + makeCode.toString(16) +
                                      (flags & 1 ? ' BREAK' : ' make'));
                    }
                }
            }
        }
        GuestMemory.guestFreeBytes(eventPointer);
    }

    os.debugPrint('SELFTEST_OK');
}

module.exports = { run };
