// ===========================================================================
// jsOS - system32/win32/ntoskrnl/rtl.js: exports Rtl* + Interlocked* (com a
// semantica real do NT sobre a memoria do convidado).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const NtAbi = require('win32/nt-abi');

const US = NtAbi.UNICODE_STRING;

// RtlFree*String real: libera o buffer e zera os campos
function freeString(pointer) {
    const buffer = GuestMemory.readGuest32(pointer + US.BUFFER);
    if (buffer) GuestMemory.guestFreeBytes(buffer);
    GuestMemory.writeGuest16(pointer, 0);
    GuestMemory.writeGuest16(pointer + 2, 0);
    GuestMemory.writeGuest32(pointer + US.BUFFER, 0);
    GuestMemory.writeGuest32(pointer + 12, 0);
    return 0;
}

module.exports = {
    names: [
        'RtlInitUnicodeString',
        'RtlCompareUnicodeString',
        'RtlCopyUnicodeString',
        'RtlEqualUnicodeString',
        'RtlInitAnsiString',
        'RtlAnsiStringToUnicodeString',
        'RtlUnicodeStringToAnsiString',
        'RtlFreeAnsiString',
        'RtlFreeUnicodeString',
        'RtlEqualString',
        'InterlockedIncrement',
        'InterlockedDecrement',
        'InterlockedExchange',
        'InterlockedCompareExchange',
        'memset',
        'memcpy',
        'memmove',
        'RtlUnicodeStringToInteger',
        'RtlIntegerToUnicodeString',
    ],
    handlers: [
        // RtlInitUnicodeString(outPtr, wideStrPtr): so aponta o buffer
        (outputPointer, wideStringPointer) => {
            const text = GuestStrings.readGuestWideString(wideStringPointer);
            GuestStrings.writeStringFields(outputPointer, text.length * 2,
                                           text.length * 2 + 2, wideStringPointer);
            return 0;
        },
        // RtlCompareUnicodeString(a, b, caseInsensitive) -> <0/0/>0
        (pointerA, pointerB, caseInsensitive) => {
            let a = GuestStrings.readUnicodeString(pointerA);
            let b = GuestStrings.readUnicodeString(pointerB);
            if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
            return a < b ? -1 : a > b ? 1 : 0;
        },
        // RtlCopyUnicodeString(dest, src): copia chars p/ o buffer do dest
        (destPointer, srcPointer) => {
            const srcChars = GuestMemory.readGuest16(srcPointer) / 2;
            const srcBuffer = GuestMemory.readGuest32(srcPointer + US.BUFFER);
            const maxChars = GuestMemory.readGuest16(destPointer + 2) / 2;
            let destBuffer = GuestMemory.readGuest32(destPointer + US.BUFFER);
            const copyChars = Math.min(srcChars, maxChars);
            if (!destBuffer && maxChars > 0) {
                destBuffer = GuestMemory.guestAllocBytes(maxChars * 2);
                GuestMemory.writeGuest32(destPointer + US.BUFFER, destBuffer);
                GuestMemory.writeGuest32(destPointer + 12, 0);
            }
            if (destBuffer)
                for (let i = 0; i < copyChars; i++)
                    GuestMemory.writeGuest16(destBuffer + i * 2,
                                             GuestMemory.readGuest16(srcBuffer + i * 2));
            GuestMemory.writeGuest16(destPointer, copyChars * 2);
            return 0;
        },
        // RtlEqualUnicodeString(a, b, caseInsensitive) -> 1/0
        (pointerA, pointerB, caseInsensitive) => {
            let a = GuestStrings.readUnicodeString(pointerA);
            let b = GuestStrings.readUnicodeString(pointerB);
            if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
            return a === b ? 1 : 0;
        },
        // RtlInitAnsiString(outPtr, cstrPtr): aponta o buffer (sem alocar)
        (outputPointer, cStringPointer) => {
            const text = GuestStrings.readGuestCString(cStringPointer);
            GuestStrings.writeStringFields(outputPointer, text.length,
                                           text.length + 1, cStringPointer);
            return 0;
        },
        // RtlAnsiStringToUnicodeString(uniPtr, ansiPtr, allocate)
        (unicodePointer, ansiPointer, allocate) => {
            const ansiBuffer = GuestMemory.readGuest32(ansiPointer + US.BUFFER);
            const text = GuestStrings.readGuestCString(ansiBuffer);
            const lengthBytes = text.length * 2;
            let buffer = GuestMemory.readGuest32(unicodePointer + US.BUFFER);
            if (allocate || !buffer) buffer = GuestMemory.guestAllocBytes(lengthBytes + 2);
            for (let i = 0; i < text.length; i++)
                GuestMemory.writeGuest16(buffer + i * 2, text.charCodeAt(i));
            GuestMemory.writeGuest16(buffer + lengthBytes, 0);
            GuestStrings.writeStringFields(unicodePointer, lengthBytes,
                                           lengthBytes + 2, buffer);
            return 0;
        },
        // RtlUnicodeStringToAnsiString(ansiPtr, uniPtr, allocate)
        (ansiPointer, unicodePointer, allocate) => {
            const text = GuestStrings.readUnicodeString(unicodePointer);
            let buffer = GuestMemory.readGuest32(ansiPointer + US.BUFFER);
            if (allocate || !buffer) buffer = GuestMemory.guestAllocBytes(text.length + 1);
            for (let i = 0; i < text.length; i++)
                GuestMemory.writeGuest8(buffer + i, text.charCodeAt(i) & 0xFF);
            GuestMemory.writeGuest8(buffer + text.length, 0);
            GuestStrings.writeStringFields(ansiPointer, text.length,
                                           text.length + 1, buffer);
            return 0;
        },
        // RtlFreeAnsiString(ptr)
        (pointer) => freeString(pointer),
        // RtlFreeUnicodeString(ptr)
        (pointer) => freeString(pointer),
        // RtlEqualString(ansiA, ansiB, caseInsensitive) -> 1/0
        (pointerA, pointerB, caseInsensitive) => {
            let a = GuestStrings.readAnsiString(pointerA);
            let b = GuestStrings.readAnsiString(pointerB);
            if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
            return a === b ? 1 : 0;
        },
        // InterlockedIncrement(ptr) -> novo valor
        (pointer) => {
            const value = (GuestMemory.readGuest32(pointer) + 1) >>> 0;
            GuestMemory.writeGuest32(pointer, value);
            return value;
        },
        // InterlockedDecrement(ptr) -> novo valor
        (pointer) => {
            const value = (GuestMemory.readGuest32(pointer) - 1) >>> 0;
            GuestMemory.writeGuest32(pointer, value);
            return value;
        },
        // InterlockedExchange(ptr, value) -> antigo
        (pointer, value) => {
            const old = GuestMemory.readGuest32(pointer);
            GuestMemory.writeGuest32(pointer, value >>> 0);
            return old;
        },
        // InterlockedCompareExchange(ptr, exchange, comparand) -> antigo
        (pointer, exchange, comparand) => {
            const old = GuestMemory.readGuest32(pointer);
            if (old === (comparand >>> 0))
                GuestMemory.writeGuest32(pointer, exchange >>> 0);
            return old;
        },
        // memset(dst, value, count) — emitida pelo compilador MSVC
        (destPointer, value, count) => {
            for (let i = 0; i < count; i++)
                GuestMemory.writeGuest8(destPointer + i, value & 0xFF);
            return destPointer;
        },
        // memcpy(dst, src, count)
        (destPointer, srcPointer, count) => {
            const tmp = [];
            for (let i = 0; i < count; i++)
                tmp.push(GuestMemory.readGuest8(srcPointer + i));
            for (let i = 0; i < count; i++)
                GuestMemory.writeGuest8(destPointer + i, tmp[i]);
            return destPointer;
        },
        // memmove(dst, src, count) — igual ao memcpy aqui (copia via temp)
        (destPointer, srcPointer, count) => {
            const tmp = [];
            for (let i = 0; i < count; i++)
                tmp.push(GuestMemory.readGuest8(srcPointer + i));
            for (let i = 0; i < count; i++)
                GuestMemory.writeGuest8(destPointer + i, tmp[i]);
            return destPointer;
        },
        // RtlUnicodeStringToInteger(uniPtr, base, outU32Ptr): base 0 = auto
        // (0x hex, 0 octal, 0b binario); semantica real do NT
        (unicodePointer, base, outputPointer) => {
            let text = GuestStrings.readUnicodeString(unicodePointer).trim();
            let effectiveBase = base >>> 0;
            let negative = false;
            if (text.startsWith('-')) { negative = true; text = text.slice(1); }
            if (effectiveBase === 0) {
                if (/^0x/i.test(text)) { effectiveBase = 16; text = text.slice(2); }
                else if (/^0b/i.test(text)) { effectiveBase = 2; text = text.slice(2); }
                else if (/^0o/i.test(text)) { effectiveBase = 8; text = text.slice(2); }
                else if (/^0[0-7]/.test(text)) { effectiveBase = 8; text = text.slice(1); }
                else effectiveBase = 10;
            }
            const parsed = parseInt(text, effectiveBase);
            if (isNaN(parsed)) return 0xC000000D | 0;   // STATUS_INVALID_PARAMETER
            const value = ((negative ? -parsed : parsed) >>> 0);
            GuestMemory.writeGuest32(outputPointer, value);
            return 0;
        },
        // RtlIntegerToUnicodeString(value, base, uniPtr): escreve no buffer da
        // UNICODE_STRING (respeita MaximumLength; STATUS_BUFFER_OVERFLOW real)
        (value, base, unicodePointer) => {
            const effectiveBase = base >>> 0 || 10;
            if (![2, 8, 10, 16].includes(effectiveBase))
                return 0xC000000D | 0;
            const text = (value >>> 0).toString(effectiveBase);
            const maxChars = GuestMemory.readGuest16(unicodePointer + 2) / 2;
            if (text.length + 1 > maxChars)
                return 0x80000005 | 0;   // STATUS_BUFFER_OVERFLOW
            const buffer = GuestMemory.readGuest32(unicodePointer + US.BUFFER);
            for (let i = 0; i < text.length; i++)
                GuestMemory.writeGuest16(buffer + i * 2, text.charCodeAt(i));
            GuestMemory.writeGuest16(buffer + text.length * 2, 0);
            GuestMemory.writeGuest16(unicodePointer, text.length * 2);
            return 0;
        },
    ],
};
