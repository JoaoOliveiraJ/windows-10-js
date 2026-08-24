// ===========================================================================
// jsOS - system32/init/phase0.js: FASE 0 do boot (estilo NT).
//
// So o nucleo minimo: interrupcoes, nanokernel, Object Manager, sistema de
// arquivos em memoria (apps embutidas) e o Registry semeado com os servicos
// (drivers) — como o hive SYSTEM que o winload entrega ao ntoskrnl.
// ===========================================================================

const Interrupts = require('nano/interrupts');
require('nano/message-channels');
require('nano/kernel');
const ObjectManager = require('ntos/ob/object-manager');
const MemoryFileSystem = require('ntos/fs/memory-file-system');
const Registry = require('ntos/cm/registry');
const HwDescription = require('ntos/cm/hw-description');
const Pfn = require('ntos/mm/pfn');
const SharedUserData = require('ntos/mm/shared-user-data');
const Smp = require('ntos/ke/smp');
const Clock = require('ntos/ke/clock');
const Scheduler = require('ntos/ps/scheduler');
const Dispatcher = require('ntos/ke/dispatcher');
const GuestMemory = require('win32/guest-memory');

function asciiBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF);
    bytes.push(0);
    return bytes;
}

function dwordBytes(value) {
    return [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF];
}

// REG_MULTI_SZ (tipo 7): cadeias UTF-16LE separadas por NUL, terminadas em
// NUL duplo — o formato real do Windows para valores como UpperFilters
function multiSzBytes(strings) {
    const bytes = [];
    for (const text of strings) {
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            bytes.push(code & 0xFF, (code >> 8) & 0xFF);
        }
        bytes.push(0, 0);
    }
    bytes.push(0, 0);
    return bytes;
}

// classe de dispositivo (HKLM\SYSTEM\CurrentControlSet\Control\Class\<guid>
// no NT; aqui sem control sets, direto em System\Control\Class) — o PnP le
// UpperFilters dela para anexar os filtros de classe sobre o FDO funcional
function seedDeviceClass(classGuid, upperFilters) {
    const handle = Registry.openOrCreate(
        '\\Registry\\Machine\\System\\Control\\Class\\' + classGuid);
    Registry.setValue(handle, 'UpperFilters', 7, multiSzBytes(upperFilters));
    Registry.closeHandle(handle);
}

// servicos = drivers carregados na fase 1 (Start: 0=boot, 1=system, 2=auto)
// hardwareId (opcional): id PnP estilo INF — o gerenciador PnP casa com o
// hardware enumerado e chama o AddDevice do driver com o PDO
function seedService(name, driverFile, start, hardwareId) {
    const handle = Registry.openOrCreate('\\Registry\\Machine\\System\\Services\\' + name);
    Registry.setValue(handle, 'DriverFile', 1, asciiBytes(driverFile));
    Registry.setValue(handle, 'Start', 4, dwordBytes(start));
    if (hardwareId)
        Registry.setValue(handle, 'HardwareId', 1, asciiBytes(hardwareId));
    Registry.closeHandle(handle);
}

function init() {
    os.debugPrint('[boot] fase 0: nanokernel + objetos + registry');
    Clock.init();               // relogio TSC de alta resolucao (calibra c/ PIT)
    Interrupts.init();
    Pfn.init();                 // memory manager: alocador de frames fisicos
    SharedUserData.init();      // pagina KUSER_SHARED_DATA mapeada (drivers WDK)
    Smp.init();                 // SMP: ACPI MADT + INIT-SIPI dos APs (LAPIC)
    Scheduler.init();           // Process Manager: System EPROCESS + KTHREAD

    ObjectManager.createDirectory('\\Device');
    ObjectManager.createDirectory('\\Driver');
    ObjectManager.createDirectory('\\DosDevices');
    // \GLOBAL??: o diretorio global de devices DOS do NT — o mountmgr cria
    // links aqui no DriverEntry (\GLOBAL??\MountedDevice etc.)
    ObjectManager.createDirectory('\\GLOBAL??');
    // eventos nomeados do kernel (\KernelObjects\*): o mountmgr abre estes
    // para sinalizacao de pressao de memoria/commit (objetos reais do NT)
    ObjectManager.createDirectory('\\KernelObjects');
    for (const eventName of ['HighMemoryCondition', 'LowMemoryCondition',
                             'HighCommitCondition', 'LowCommitCondition',
                             'MaximumCommitCondition']) {
        const eventPointer = GuestMemory.guestAllocBytes(0x18);
        Dispatcher.initializeEvent(eventPointer, 0, 0);   // Notification, nao-sinalizado
        ObjectManager.createObject('\\KernelObjects', eventName, 'Event',
                                   { eventPointer });
    }

    // apps embutidas viram arquivos do VFS ( /<basename> )
    for (const name of os.listBundleFiles()) {
        if (!name.startsWith('apps/')) continue;
        const dst = '/' + name.split('/').pop();
        if (name.endsWith('.exe') || name.endsWith('.sys'))
            MemoryFileSystem.writeBytes(dst, os.readBundleBytes(name));
        else
            MemoryFileSystem.write(dst, os.readBundleText(name));
    }
    ObjectManager.mount('\\FS', MemoryFileSystem);
    ObjectManager.createSymlink('\\DosDevices\\C:', '\\FS');

    // hive: servicos com driver .sys (como \System\Services no NT)
    seedService('echo',      'echo.sys',      1);
    seedService('irplife',   'irplife.sys',   1);
    seedService('rtlstr',    'rtlstr.sys',    1);
    seedService('ketime',    'ketime.sys',    1);
    seedService('mmmem',     'mmmem.sys',     1);
    seedService('expool',    'expool.sys',    1);
    seedService('interlock', 'interlock.sys', 1);
    seedService('irql',      'irql.sys',      1);
    seedService('rtlansi',   'rtlansi.sys',   1);
    seedService('registry',  'registry.sys',  1);
    seedService('power',     'power.sys',     1);
    // VGA PCI (1234:1111 bochs/std): PnP casa o driver com o PDO pelo id
    seedService('pcidemo',   'pcidemo.sys',   1, 'PCI\\VEN_1234&DEV_1111');
    // Start=3 (demand): carregado sob demanda via ZwLoadDriver (loader.sys)
    seedService('ondemand',  'lifecycle.sys', 3);
    // i8042prt: servico demand (o selftest carrega) + a subchave Parameters
    // como no Windows real (o driver le os defaults de la no DriverEntry)
    seedService('i8042prt',  'i8042prt.sys',  3);
    // kbdclass/mouclass: filtros de classe (upper filters), carregados quando
    // o PnP casa um devnode da classe Keyboard/Mouse — como o NT faz
    seedService('kbdclass',  'kbdclass.sys',  3);
    seedService('mouclass',  'mouclass.sys',  3);
    // ---- pilha de armazenamento (ordem de boot do NT: port -> class -> mntmgr)
    // atapi: miniport IDE; o DriverEntry chama AtaPortInitialize (ataport.sys
    // carrega como DEPENDENCIA de import, sem servico proprio — como no NT).
    // O casamento com o controlador IDE PCI e' pelo "INF estatico" do pnp.js.
    seedService('atapi',    'atapi.sys',    0);
    // disk: driver de classe de disco; anexa nos PDOs que o ataport enumera
    // (hardwareId "IDE\Disk..." casado por prefixo — como o disk.inf do NT)
    seedService('disk',     'disk.sys',     0);
    // mountmgr: Mount Manager — registra notificacoes de chegada de volume e
    // mantem o banco de pontos de montagem (\Registry\Machine\System\MountedDevices)
    seedService('mountmgr', 'mountmgr.sys', 0);
    seedServiceParameters('i8042prt', [
        ['KeyboardDataQueueSize', 4, dwordBytes(0x64)],
        ['MouseDataQueueSize',    4, dwordBytes(0x64)],
        ['PollStatusIterations',  4, dwordBytes(0x2000)],
        ['PollingIterations',     4, dwordBytes(0x1900)],
        ['ResendIterations',      4, dwordBytes(3)],
        ['OverrideKeyboardType',  4, dwordBytes(0)],
        ['CrashOnCtrlScroll',     4, dwordBytes(0)],
    ]);
    // classes de dispositivo com seus upper filters (o INF da classe teclado/
    // mouse do Windows registra kbdclass/mouclass exatamente assim)
    seedDeviceClass('{4D36E96B-E325-11CE-BFC1-08002BE10318}', ['kbdclass']);
    seedDeviceClass('{4D36E96F-E325-11CE-BFC1-08002BE10318}', ['mouclass']);
    // arvore de descricao de hardware (o que o HAL povoa: 8042 no barramento
    // ISA) — lida pelo IoQueryDeviceDescription dos drivers legados
    HwDescription.seedHardwareDescription();
}

// Parameters de um servico (subchave Parameters, como o INF criaria)
function seedServiceParameters(name, entries) {
    const handle = Registry.openOrCreate(
        '\\Registry\\Machine\\System\\Services\\' + name + '\\Parameters');
    for (const [valueName, type, data] of entries)
        Registry.setValue(handle, valueName, type, data);
    Registry.closeHandle(handle);
}

module.exports = { init };
