// ===========================================================================
// jsOS - system32/ntos/mm/memory.js: Memory Manager - visao de memoria
// do kernel (heap + RAM E820).
// ===========================================================================

const Console = require('drivers/console/console');

function fmt(bytes) {
    if (bytes >= 1048576) return Math.floor(bytes / 1048576) + ' MB';
    return Math.floor(bytes / 1024) + ' KB';
}

function cmdMem() {
    const h = os.getHeapInfo();
    Console.print('RAM total : ' + fmt(os.getRamSize()) + ' (via E820)');
    Console.print('heap      : ' + fmt(h.used) + ' usados / ' + fmt(h.total) + ' total');
    Console.print('livre     : ' + fmt(h.total - h.used));
}

module.exports = { cmdMem, fmt };
