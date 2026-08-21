// ===========================================================================
// jsOS - system32/drivers/console/console.js: console do kernel
// (tela VGA + espelho serial).
// ===========================================================================

const VGA = require('drivers/video/vga');

module.exports = {
    write(s) { VGA.write(s); },
    print(s) { VGA.write(String(s) + '\n'); },
    log(s)   { VGA.write(String(s) + '\n'); os.print(s); },  // tela + serial
    clear()  { VGA.clear(); },
};
