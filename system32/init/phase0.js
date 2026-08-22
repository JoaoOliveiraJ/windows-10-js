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
const Pfn = require('ntos/mm/pfn');
const SharedUserData = require('ntos/mm/shared-user-data');
const Smp = require('ntos/ke/smp');
const Clock = require('ntos/ke/clock');
const Scheduler = require('ntos/ps/scheduler');

function asciiBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF);
    bytes.push(0);
    return bytes;
}

function dwordBytes(value) {
    return [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF];
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
}

module.exports = { init };
