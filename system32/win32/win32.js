// ===========================================================================
// jsOS - system32/win32/win32.js: mini-kernel32 em JavaScript (modulo).
//
// O .exe convidado chama as funcs via IAT -> trampolim asm (ABI MS -> SysV)
// -> js_win32_dispatch (C) -> Win32.handle(id, a1..a4) aqui.
// ===========================================================================

const VGA = require('drivers/video/vga');

const apiNames = [
    'GetStdHandle',     // 0
    'WriteFile',        // 1
    'ExitProcess',      // 2
    'GetTickCount',     // 3
];

let lastWrite = '';

function lookup(dll, name) {
    if (!/^kernel32\.dll$/i.test(dll)) return -1;
    return apiNames.indexOf(name);
}

function readGuest(addr, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(os.peek8(addr + i));
    return s;
}

function handle(id, a1, a2, a3, a4) {
    switch (id) {
    case 0:  // GetStdHandle(n) -> handle fake
        return 1;
    case 1: { // WriteFile(h, buf, len, pWritten, ovl)
        const text = readGuest(a2, a3);
        lastWrite = text;
        VGA.write(text);
        os.write(text);
        if (a4) os.poke32(a4, a3);
        return 1;
    }
    case 2:  // ExitProcess(code) - ver README (demo usa 'ret')
        os.print('[win32] ExitProcess(' + a1 + ')');
        return 0;
    case 3:  // GetTickCount()
        return Date.now() & 0xFFFFFFFF;
    }
    os.print('[win32] API desconhecida id=' + id);
    return 0;
}

// o C (js_win32_dispatch) procura globalThis.Win32.handle
globalThis.Win32 = { handle };

module.exports = {
    lookup,
    get lastWrite() { return lastWrite; },
};
