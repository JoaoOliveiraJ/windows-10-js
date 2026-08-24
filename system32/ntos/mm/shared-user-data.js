// ===========================================================================
// jsOS - system32/ntos/mm/shared-user-data.js: a pagina KUSER_SHARED_DATA.
//
// O Windows mapeia 0xFFFFF78000000000 em todo espaco de endereco; o kernel
// atualiza SharedSystemTime (+0x14) e SharedTickCount (+0x320). Drivers
// compilados com o WDK leem ali direto (KeQuerySystemTime/KeQueryTickCount
// sao macros inline). O jsOS faz igual: mapeia a pagina de verdade e atualiza
// os campos a cada tick do kernel (funciona tambem sem IRQs/WHPX).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const Pfn = require('ntos/mm/pfn');
const Paging = require('ntos/mm/paging');

const SHARED_USER_DATA_VA = 0xFFFFF78000000000;   // KI_USER_SHARED_DATA x64
const OFFSET_SYSTEM_TIME = 0x14;
const OFFSET_TICK_COUNT  = 0x320;

let sharedFrame = 0;
const bootEpochMs = Date.now();

function writeShared64(offset, value) {
    GuestMemory.writeGuest32(sharedFrame + offset, value % 0x100000000);
    GuestMemory.writeGuest32(sharedFrame + offset + 4, Math.floor(value / 0x100000000));
}

function init() {
    sharedFrame = Pfn.allocPage();
    if (!sharedFrame) {
        os.debugPrint('[mm] FALHA: sem frame p/ shared user data');
        return false;
    }
    for (let i = 0; i < 0x1000; i += 4)
        GuestMemory.writeGuest32(sharedFrame + i, 0);
    if (!Paging.mapPage(SHARED_USER_DATA_VA, sharedFrame,
                        Paging.PAGE_PRESENT | Paging.PAGE_RW)) {
        os.debugPrint('[mm] FALHA: map shared user data');
        return false;
    }
    // publica o frame p/ o C (a IRQ do timer atualiza o SystemTime aqui de
    // forma preemptiva — ver jsos_irq_native_dispatch)
    os.writePhysical32(0x81530, sharedFrame);
    updateSystemTimes();
    os.debugPrint('[mm] KUSER_SHARED_DATA mapeada (frame 0x' +
                  sharedFrame.toString(16) + ')');
    return true;
}

// chamado a cada tick do kernel (idle loop): mantem o relogio compartilhado
function updateSystemTimes() {
    writeShared64(OFFSET_SYSTEM_TIME, (Date.now() + 11644473600000) * 10000);
    writeShared64(OFFSET_TICK_COUNT, Date.now() - bootEpochMs);
}

module.exports = { init, updateSystemTimes };
