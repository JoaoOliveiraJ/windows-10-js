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
const KeyboardDriver = require('drivers/input/keyboard');
const Ntfs = require('ntos/fs/ntfs');
const PciBus = require('drivers/bus/pci');

function init() {
    os.debugPrint('[boot] fase 1: I/O manager + drivers + servicos');

    IoManager.init();
    ConsoleDriver.DriverEntry(IoManager);
    KeyboardDriver.DriverEntry(IoManager);

    // NTFS: disco slave IDE vira D: (se presente)
    if (AtaPio.present(1)) {
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
}

module.exports = { init };
