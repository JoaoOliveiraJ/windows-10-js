// ===========================================================================
// jsOS - system32/drivers/input/keyboard.js: driver de teclado PS/2 por polling (modulo).
// Le a porta 0x60 quando 0x64 sinaliza dado (sem IRQ/IDT).
// Scancodes set 1 -> ASCII, com Shift e Backspace.
// ===========================================================================

const PORT_ST = 0x64, PORT_DT = 0x60;

// set 1, make codes (indice = scancode)
const NORMAL = [
    0, 0, '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', '\b', '\t',
    'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\n', 0,
    'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", '`', 0, '\\',
    'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 0, '*', 0, ' ',
];
const SHIFTED = [
    0, 0, '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '\b', '\t',
    'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '{', '}', '\n', 0,
    'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ':', '"', '~', 0, '|',
    'Z', 'X', 'C', 'V', 'B', 'N', 'M', '<', '>', '?', 0, '*', 0, ' ',
];
const SC_LSHIFT = 0x2A, SC_RSHIFT = 0x36;
let shift = false;

// decodifica um scancode; retorna char, ou null (tecla sem mapa/modificador)
function decode(sc) {
    if (sc & 0x80) {                              // break code (soltou)
        const make = sc & 0x7F;
        if (make === SC_LSHIFT || make === SC_RSHIFT) shift = false;
        return null;
    }
    if (sc === SC_LSHIFT || sc === SC_RSHIFT) { shift = true; return null; }
    if (sc === 0xE0) {                            // estendido: descarta o proximo
        if (os.inb(PORT_ST) & 1) os.inb(PORT_DT);
        return null;
    }
    const table = shift ? SHIFTED : NORMAL;
    return (sc < table.length && table[sc]) ? table[sc] : null;
}

// nao-bloqueante: char ou null se nao ha tecla
function pollKey() {
    if ((os.inb(PORT_ST) & 1) === 0) return null;
    return decode(os.inb(PORT_DT));
}

// bloqueante
function readKey() {
    for (;;) {
        const k = pollKey();
        if (k !== null) return k;
    }
}

module.exports = { readKey, pollKey };
