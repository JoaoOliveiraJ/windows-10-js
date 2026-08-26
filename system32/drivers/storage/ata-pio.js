// ===========================================================================
// jsOS - system32/drivers/storage/atapio.js: driver de disco ATA PIO (LBA28).
// 100% JS: fala com o controlador IDE pelas portas 0x1F0-0x1F7 via
// os.readPort8/writePort8/readPort16.
// ===========================================================================

const ATA_DATA    = 0x1F0;
const ATA_SECTORS = 0x1F2;
const ATA_LBA_LO  = 0x1F3;
const ATA_LBA_MID = 0x1F4;
const ATA_LBA_HI  = 0x1F5;
const ATA_DRIVE   = 0x1F6;
const ATA_STATUS  = 0x1F7;
const ATA_CMD     = 0x1F7;
const ATA_CMD_READ = 0x20;

const SR_BSY = 0x80, SR_DRQ = 0x08, SR_ERR = 0x01;

function waitReady() {
    while (os.readPort8(ATA_STATUS) & SR_BSY) { }
}

function waitData() {
    for (;;) {
        const st = os.readPort8(ATA_STATUS);
        if (st & SR_ERR) throw new Error('ATA: erro de leitura');
        if (!(st & SR_BSY) && (st & SR_DRQ)) return;
    }
}

// le `count` setores (512 bytes) a partir do LBA; drive: 0=master, 1=slave
let ataPioReadLogCount = 0;
function readSectors(lba, count, drive) {
    if (++ataPioReadLogCount <= 3 || (lba >= 14 && lba <= 17))
        os.debugPrint('[atapio] readSectors lba=' + lba + ' count=' + count +
                      ' drive=' + drive);
    const out = new Uint8Array(count * 512);
    for (let s = 0; s < count; s++) {
        const l = lba + s;
        waitReady();
        os.writePort8(ATA_SECTORS, 1);
        os.writePort8(ATA_LBA_LO, l & 0xFF);
        os.writePort8(ATA_LBA_MID, (l >> 8) & 0xFF);
        os.writePort8(ATA_LBA_HI, (l >> 16) & 0xFF);
        os.writePort8(ATA_DRIVE, 0xE0 | ((drive & 1) << 4) | ((l >> 24) & 0x0F));
        os.writePort8(ATA_CMD, ATA_CMD_READ);
        waitData();
        for (let i = 0; i < 256; i++) {
            const w = os.readPort16(ATA_DATA);
            out[s * 512 + i * 2] = w & 0xFF;
            out[s * 512 + i * 2 + 1] = (w >> 8) & 0xFF;
        }
    }
    return out;
}

// detecta se um drive responde (status nao-flutuante)
function present(drive) {
    os.writePort8(ATA_DRIVE, 0xE0 | ((drive & 1) << 4));
    waitReady();
    const st = os.readPort8(ATA_STATUS);
    return st !== 0xFF && st !== 0x00;
}

module.exports = { readSectors, present };
