// ===========================================================================
// jsOS - system32/drivers/video/vga.js: driver VGA modo texto 80x25 (modulo).
// Escreve direto na memoria de video 0xB8000 via os.poke16 e move o cursor
// de hardware via portas 0x3D4/0x3D5.
// ===========================================================================

const MEM = 0xB8000, W = 80, H = 25;
let cx = 0, cy = 0, attr = 0x07; // cinza claro / preto

function hwCursor() {
    const p = cy * W + cx;
    os.outb(0x3D4, 0x0F); os.outb(0x3D5, p & 0xFF);
    os.outb(0x3D4, 0x0E); os.outb(0x3D5, (p >> 8) & 0xFF);
}

function blank() { return (attr << 8) | 0x20; }

function clearLine(y) {
    for (let x = 0; x < W; x++) os.poke16(MEM + (y * W + x) * 2, blank());
}

function scroll() {
    for (let y = 1; y < H; y++)
        for (let x = 0; x < W; x++)
            os.poke16(MEM + ((y - 1) * W + x) * 2, os.peek16(MEM + (y * W + x) * 2));
    clearLine(H - 1);
    cy = H - 1;
}

function putc(c) {
    if (c === '\n') { cx = 0; cy++; }
    else if (c === '\r') { cx = 0; }
    else if (c === '\b') {
        if (cx > 0) { cx--; os.poke16(MEM + (cy * W + cx) * 2, blank()); }
    }
    else if (c === '\t') {
        cx = (cx + 8) & ~7;
        if (cx >= W) { cx = 0; cy++; }
    }
    else {
        os.poke16(MEM + (cy * W + cx) * 2, (attr << 8) | (c.charCodeAt(0) & 0xFF));
        cx++;
        if (cx >= W) { cx = 0; cy++; }
    }
    if (cy >= H) scroll();
}

function write(s) {
    s = String(s);
    for (let i = 0; i < s.length; i++) putc(s[i]);
    hwCursor();
}

function clear() {
    for (let y = 0; y < H; y++) clearLine(y);
    cx = 0; cy = 0;
    hwCursor();
}

function setAttr(a) { attr = a & 0xFF; }

module.exports = { write, clear, setAttr, putc };
