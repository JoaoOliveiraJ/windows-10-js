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

function init() {
    os.debugPrint('[boot] fase 1: I/O manager + drivers + servicos');

    IoManager.init();
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

    // drivers de servico lidos do Registry + PnP start
    const loaded = Services.startBootDrivers();
    os.debugPrint('[boot] servicos carregados: ' + loaded);
}

module.exports = { init };
