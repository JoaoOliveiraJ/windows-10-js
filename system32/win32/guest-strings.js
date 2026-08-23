// ===========================================================================
// jsOS - system32/win32/guest-strings.js: strings do convidado.
//
// Layout REAL do NT (WDK): UNICODE_STRING = { u16 Length @0, u16
// MaximumLength @2, u32 pad @4, u64 Buffer @8 }; ANSI_STRING = idem com
// bytes 8-bit. Leitura/escrita na memoria fisica do convidado.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

// guarda contra leitura descontrolada: se o ponteiro estiver errado o loop
// nunca acha o NUL e a string cresce ate estourar a heap (debug: stack trace)
const MAX_GUEST_STRING_CHARS = 65536;

function runawayStringDiagnostic(kind, startAddress) {
    os.debugPrint('[strings] ' + kind + ' SEM NUL em 0x' +
                  (startAddress >>> 0).toString(16) + ' (>64K chars)');
    os.debugPrint(new Error('stack').stack || '(sem stack)');
    os.halt();
}

function readGuestCString(address) {
    const startAddress = address;
    let text = '';
    let count = 0;
    for (let b = GuestMemory.readGuest8(address); b !== 0;
         b = GuestMemory.readGuest8(++address)) {
        if (++count > MAX_GUEST_STRING_CHARS)
            runawayStringDiagnostic('C-string', startAddress);
        text += String.fromCharCode(b);
    }
    return text;
}

function readGuestWideString(address) {
    const startAddress = address;
    let text = '';
    let count = 0;
    for (let w = GuestMemory.readGuest16(address); w !== 0;
         w = GuestMemory.readGuest16(address += 2)) {
        if (++count > MAX_GUEST_STRING_CHARS)
            runawayStringDiagnostic('wide-string', startAddress);
        text += String.fromCharCode(w);
    }
    return text;
}

function readUnicodeString(pointer) {
    const charCount = GuestMemory.readGuest16(pointer) / 2;
    const buffer = GuestMemory.readGuest32(pointer + 8);
    if (charCount > MAX_GUEST_STRING_CHARS)
        runawayStringDiagnostic('UNICODE_STRING len=' + charCount, pointer);
    let text = '';
    for (let i = 0; i < charCount; i++)
        text += String.fromCharCode(GuestMemory.readGuest16(buffer + i * 2));
    return text;
}

function readAnsiString(pointer) {
    const length = GuestMemory.readGuest16(pointer);
    const buffer = GuestMemory.readGuest32(pointer + 8);
    if (length > MAX_GUEST_STRING_CHARS)
        runawayStringDiagnostic('ANSI_STRING len=' + length, pointer);
    let text = '';
    for (let i = 0; i < length; i++)
        text += String.fromCharCode(GuestMemory.readGuest8(buffer + i));
    return text;
}

// campos de uma (UNICODE|ANSI)_STRING: { u16 len, u16 max, u32 pad, u64 buf }
function writeStringFields(pointer, lengthBytes, maximumBytes, bufferPointer) {
    GuestMemory.writeGuest16(pointer, lengthBytes);
    GuestMemory.writeGuest16(pointer + 2, maximumBytes);
    GuestMemory.writeGuest32(pointer + 4, 0);
    GuestMemory.writeGuest32(pointer + 8, bufferPointer >>> 0);
    GuestMemory.writeGuest32(pointer + 12, 0);
}

function writeGuestWideString(address, text) {
    for (let i = 0; i < text.length; i++)
        GuestMemory.writeGuest16(address + i * 2, text.charCodeAt(i));
    GuestMemory.writeGuest16(address + text.length * 2, 0);
}

function writeGuestBytes(address, bytes) {
    for (let i = 0; i < bytes.length; i++)
        GuestMemory.writeGuest8(address + i, bytes[i]);
}

// formata uma string printf-style lendo args do convidado:
// %d %i %u %x %X %p %c %% %s (C-string) %S/%wZ (UNICODE_STRING*)
function formatGuestText(formatText, args) {
    let out = '';
    let argIndex = 0;
    for (let i = 0; i < formatText.length; i++) {
        if (formatText[i] !== '%') { out += formatText[i]; continue; }
        let spec = formatText[++i];
        if (spec === '%') { out += '%'; continue; }
        if (spec === 'w' && formatText[i + 1] === 'Z') { spec = 'wZ'; i++; }
        const value = args[argIndex++] || 0;
        switch (spec) {
        case 'd': case 'i': out += String(value | 0); break;
        case 'u': out += String(value >>> 0); break;
        case 'x': out += (value >>> 0).toString(16); break;
        case 'X': out += (value >>> 0).toString(16).toUpperCase(); break;
        case 'p': out += '0x' + (value >>> 0).toString(16).padStart(8, '0'); break;
        case 'c': out += String.fromCharCode(value & 0xFF); break;
        case 's': out += readGuestCString(value); break;
        case 'S': case 'wZ':
            out += readUnicodeString(value);
            break;
        default: out += '%' + spec;
        }
    }
    return out;
}

module.exports = { readGuestCString, readGuestWideString, readUnicodeString,
                   readAnsiString, writeStringFields, writeGuestWideString,
                   writeGuestBytes, formatGuestText };
