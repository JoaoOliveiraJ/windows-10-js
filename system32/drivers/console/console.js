// ===========================================================================
// jsOS - system32/drivers/console/console.js: console do kernel
// (tela VGA + espelho serial).
// Exporta DriverEntry (estilo NT): registra \Driver\Console e
// \Device\Console no I/O Manager.
// ===========================================================================

const VGA = require('drivers/video/vga');

module.exports = {
    write(s) { VGA.write(s); },
    print(s) { VGA.write(String(s) + '\n'); },
    log(s)   { VGA.write(String(s) + '\n'); os.debugPrint(s); },  // tela + serial
    clear()  { VGA.clear(); },

    // DriverEntry estilo NT: chamado pelo kernel na inicializacao
    DriverEntry(IoManager) {
        const drv = IoManager.createDriver('Console', {
            [IoManager.IRP_MJ.WRITE]: (dev, irp) => {
                const text = String(irp.params.data);
                VGA.write(text);
                irp.info = text.length;
            },
        });
        IoManager.createDevice(drv, 'Console');
        return true;
    },
};
