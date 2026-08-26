// ===========================================================================
// jsOS - system32/init/phase1.js: FASE 1 do boot (estilo NT).
//
// Sobe o I/O Manager, os drivers internos (DriverEntry), o NTFS, e entao
// carrega os drivers de servico LIDOS DO REGISTRY (como o NT), mandando
// IRP_MJ_PNP/START_DEVICE para cada device (PnP).
// ===========================================================================

const ObjectManager = require('ntos/ob/object-manager');
const IoManager = require('ntos/io/io-manager');
const AtaPio = require('drivers/storage/ata-pio');
const Services = require('ntos/cm/services');
const ConsoleDriver = require('drivers/console/console');
const Ntfs = require('ntos/fs/ntfs');
const PciBus = require('drivers/bus/pci');
const Lifecycle = require('win32/ntoskrnl/lifecycle');

function init() {
    os.debugPrint('[boot] fase 1: I/O manager + drivers + servicos');

    IoManager.init();
    ConsoleDriver.DriverEntry(IoManager);
    // o teclado agora e' do i8042prt.sys + kbdclass.sys da Microsoft (PnP real
    // sobre o 8042) — o driver JS antigo (drivers/input/keyboard.js) nao e'
    // mais registrado como \Device\Keyboard; so o decode ASCII dele e' reusado
    // pelo servico de teclado que le do \Device\KeyboardClass0

    // NTFS: o disco IDE e' do atapi.sys da Microsoft (driver real). O nosso
    // ata-pio.js NAO toca mais no controlador — dois drivers no mesmo IDE
    // deixam o canal em estado que o atapi nao reconhece. A montagem NTFS
    // volta quando a pilha atapi->disk estiver de pe.
    if (false && AtaPio.present(1)) {
        try {
            const ntfs = Ntfs.mount(1);
            ObjectManager.mount('\\NTFS', ntfs);
            ObjectManager.createSymlink('\\DosDevices\\D:', '\\NTFS');
            os.debugPrint('[boot] NTFS montado em D:');
        } catch (e) {
            os.debugPrint('[boot] NTFS falhou: ' + e.message);
        }
    }

    // barramento PCI PRIMEIRO (como o pci.sys do NT): enumera o hardware e
    // cria os PDOs com recursos reais, antes dos drivers funcionais
    const pciFunctionCount = PciBus.init();
    os.debugPrint('[boot] PCI: ' + pciFunctionCount + ' funcoes');

    // drivers de servico lidos do Registry + PnP start
    const loaded = Services.startBootDrivers();
    os.debugPrint('[boot] servicos carregados: ' + loaded);

    // pilha de ARMAZENAMENTO (estilo NT no boot): o PnP monta a pilha do
    // controlador IDE PCI — atapi/ataport (port) -> QUERY_DEVICE_RELATIONS
    // enumera os discos -> disk.sys+classpnp anexam em cada PDO IDE\Disk
    const Pnp = require('ntos/io/pnp');
    for (const pciFunction of PciBus.devices) {
        if (pciFunction.classCode === 0x01 && pciFunction.subClass === 0x01 &&
            pciFunction.node) {
            os.debugPrint('[boot] controlador IDE em ' + pciFunction.bus + ':' +
                          pciFunction.device + '.' + pciFunction.func +
                          ' — montando pilha de armazenamento');
            Pnp.enumeratePdoStack(pciFunction.node);
        }
    }

    // DIAGNOSTICO (temporario): drena o work item de deteccao do atapi e
    // despeja as portas IDE que ele usou no scan (ataport-trace)
    {
        const Interrupts = require('nano/interrupts');
        const Ntoskrnl = require('win32/ntoskrnl');
        for (let drainIndex = 0; drainIndex < 600; drainIndex++) {
            Interrupts.dispatchPending();
            Ntoskrnl.runKernelTasks();
        }
        require('win32/ataport-trace').dumpResults();
        // estado real do canal IDE primario apos a deteccao do atapi:
        // 0x1F7 status (0x50=pronto DRDY|DSC, 0x80=BSY/reset), 0x1F2/3/4/5 =
        // assinatura do drive (ATA: 01 01 00 00), 0x3F6 = controle (SRST?)
        os.debugPrint('[idedbg] 0x1F7 status=0x' +
            os.readPort8(0x1F7).toString(16) + ' 0x3F6 ctrl=0x' +
            os.readPort8(0x3F6).toString(16) + ' sig 0x1F2-5=0x' +
            os.readPort8(0x1F2).toString(16) + ' ' + os.readPort8(0x1F3).toString(16) +
            ' ' + os.readPort8(0x1F4).toString(16) + ' ' + os.readPort8(0x1F5).toString(16) +
            ' drv/head 0x1F6=0x' + os.readPort8(0x1F6).toString(16));
    }

    // rotinas IoRegisterDriverReinitialization rodam agora (como no NT)
    Lifecycle.runReinitializationRoutines();
}

module.exports = { init };
