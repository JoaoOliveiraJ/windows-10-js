// ===========================================================================
// jsOS - system32/win32/ntoskrnl/rtl.js: exports Rtl* + Interlocked* (com a
// semantica real do NT sobre a memoria do convidado).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const Registry = require('ntos/cm/registry');
const NtAbi = require('win32/nt-abi');
const Irql = require('ntos/ke/irql');

const US = NtAbi.UNICODE_STRING;
const TWO_POW_63 = 0x8000000000000000;

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

// escreve `text` numa UNICODE_STRING de destino (upcase/downcase etc.):
// aloca o buffer se pedido/sem buffer; respeita MaximumLength
function writeConvertedString(destPointer, text, allocate) {
    let buffer = GuestMemory.readGuest32(destPointer + US.BUFFER);
    if (allocate || !buffer) {
        buffer = GuestMemory.guestAllocBytes(text.length * 2 + 2);
        GuestMemory.writeGuest32(destPointer + US.BUFFER, buffer);
        GuestMemory.writeGuest32(destPointer + 12, 0);
        GuestMemory.writeGuest16(destPointer + 2, text.length * 2 + 2);
    } else if (GuestMemory.readGuest16(destPointer + 2) < text.length * 2 + 2) {
        return 0x80000005 | 0;   // STATUS_BUFFER_OVERFLOW
    }
    for (let i = 0; i < text.length; i++)
        GuestMemory.writeGuest16(buffer + i * 2, text.charCodeAt(i));
    GuestMemory.writeGuest16(buffer + text.length * 2, 0);
    GuestMemory.writeGuest16(destPointer, text.length * 2);
    return 0;
}

// concatena texto no buffer do dest (respeita MaximumLength)
function appendToUnicodeString(destPointer, newText) {
    const maxChars = GuestMemory.readGuest16(destPointer + 2) / 2;
    if (newText.length + 1 > maxChars)
        return 0x80000005 | 0;   // STATUS_BUFFER_OVERFLOW
    const buffer = GuestMemory.readGuest32(destPointer + US.BUFFER);
    for (let i = 0; i < newText.length; i++)
        GuestMemory.writeGuest16(buffer + i * 2, newText.charCodeAt(i));
    GuestMemory.writeGuest16(buffer + newText.length * 2, 0);
    GuestMemory.writeGuest16(destPointer, newText.length * 2);
    return 0;
}

// spinlock (test-and-set + IRQL DISPATCH) para os ExInterlocked* de lista —
// mesma semantica dos Ke*SpinLock (ver ke.js)
function spinLockAcquire(spinLockPointer) {
    const oldIrql = Irql.getIrql();
    Irql.raiseIrql(Irql.DISPATCH_LEVEL);
    for (;;) {
        if (GuestMemory.readGuest32(spinLockPointer) === 0) {
            GuestMemory.writeGuest32(spinLockPointer, 1);
            return oldIrql;
        }
    }
}
function spinLockRelease(spinLockPointer, oldIrql) {
    GuestMemory.writeGuest32(spinLockPointer, 0);
    Irql.lowerIrql(oldIrql);
}

// RtlQueryRegistryValues[Ex](relativeTo, pathWStr, queryTablePtr, contextPtr,
// environmentPtr): anda a RTL_QUERY_REGISTRY_TABLE — cada entrada tem Name
// (PCWSTR). No NT a versao sem Ex chama esta (mesma assinatura).
function queryRegistryValues(relativeTo, pathPointer, queryTablePointer,
                             _contextPointer, _environmentPointer) {
    const keyPath = GuestStrings.readGuestWideString(pathPointer);
    os.debugPrint('[rtl] QueryRegistry path="' + keyPath +
                  '" table=0x' + (queryTablePointer >>> 0).toString(16));
    const keyHandle = Registry.open(keyPath);
    if (!keyHandle) return 0xC0000034 | 0;
    let cursor = queryTablePointer;
    for (;;) {
        const queryRoutine = GuestMemory.readGuest64(cursor);
        const flags = GuestMemory.readGuest32(cursor + 8);
        const namePointer = GuestMemory.readGuest64(cursor + 0x10);
        const entryContext = GuestMemory.readGuest64(cursor + 0x18);
        const defaultType = GuestMemory.readGuest32(cursor + 0x20);
        const defaultData = GuestMemory.readGuest64(cursor + 0x28);
        const defaultLength = GuestMemory.readGuest32(cursor + 0x30);
        if (!queryRoutine && !namePointer) break;   // fim da tabela
        // Name e' PCWSTR (string wide crua), NAO UNICODE_STRING*
        const valueName = namePointer
            ? GuestStrings.readGuestWideString(namePointer) : '';
        const entry = valueName
            ? Registry.getValue(keyHandle, valueName) : null;
        if (entry && entryContext) {
            // RTL_QUERY_REGISTRY_DIRECT: escreve o valor direto
            if (entry.type === 4 && entry.data.length >= 4) {
                GuestMemory.writeGuest32(entryContext,
                    entry.data[0] | (entry.data[1] << 8) |
                    (entry.data[2] << 16) | (entry.data[3] << 24));
            } else {
                for (let i = 0; i < entry.data.length; i++)
                    GuestMemory.writeGuest8(entryContext + i,
                                            entry.data[i]);
            }
        } else if (!entry && defaultData && entryContext &&
                   defaultType === 4) {
            GuestMemory.writeGuest32(entryContext,
                GuestMemory.readGuest32(defaultData));
        }
        cursor += 0x38;   // sizeof(RTL_QUERY_REGISTRY_TABLE) x64
    }
    Registry.closeHandle(keyHandle);
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
        'RtlZeroMemory',
        'RtlFillMemory',
        'RtlCopyMemory',
        'RtlMoveMemory',
        'RtlCompareMemory',
        'RtlUpcaseUnicodeString',
        'RtlDowncaseUnicodeString',
        'RtlPrefixUnicodeString',
        'RtlAppendUnicodeStringToString',
        'RtlAppendUnicodeToString',
        'InterlockedPushEntryList',
        'InterlockedPopEntryList',
        'ExInterlockedInsertTailList',
        'ExInterlockedRemoveHeadList',
        'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat',
        'strchr', 'strstr',
        'sprintf', 'snprintf',
        'RtlRandom', 'RtlRandomEx',
        'RtlVerifyVersionInfo',
        'VerSetConditionMask',
        'RtlWriteRegistryValue',
        'RtlQueryRegistryValues',
        'RtlQueryRegistryValuesEx',
        '_vsnwprintf',
    ],
    handlers: [
        // RtlInitUnicodeString(outPtr, wideStrPtr): so aponta o buffer.
        // Semantica REAL do NT (WDK/ReactOS): SourceString NULL -> Length=0,
        // MaximumLength=0, Buffer=NULL (sem ler endereco 0!)
        (outputPointer, wideStringPointer) => {
            if (!wideStringPointer) {
                GuestStrings.writeStringFields(outputPointer, 0, 0, 0);
                return 0;
            }
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
        // RtlInitAnsiString(outPtr, cstrPtr): aponta o buffer (sem alocar);
        // SourceString NULL -> Length/MaximumLength=0, Buffer=NULL (como o NT)
        (outputPointer, cStringPointer) => {
            if (!cStringPointer) {
                GuestStrings.writeStringFields(outputPointer, 0, 0, 0);
                return 0;
            }
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
        // RtlZeroMemory(dst, length)
        (destPointer, length) => {
            for (let i = 0; i < length; i++)
                GuestMemory.writeGuest8(destPointer + i, 0);
            return 0;
        },
        // RtlFillMemory(dst, length, fillByte)
        (destPointer, length, fillByte) => {
            for (let i = 0; i < length; i++)
                GuestMemory.writeGuest8(destPointer + i, fillByte & 0xFF);
            return 0;
        },
        // RtlCopyMemory(dst, src, length) — regioes nao sobrepostas
        (destPointer, srcPointer, length) => {
            for (let i = 0; i < length; i++)
                GuestMemory.writeGuest8(destPointer + i,
                                        GuestMemory.readGuest8(srcPointer + i));
            return 0;
        },
        // RtlMoveMemory(dst, src, length) — seguro com sobreposicao
        (destPointer, srcPointer, length) => {
            const tmp = [];
            for (let i = 0; i < length; i++)
                tmp.push(GuestMemory.readGuest8(srcPointer + i));
            for (let i = 0; i < length; i++)
                GuestMemory.writeGuest8(destPointer + i, tmp[i]);
            return 0;
        },
        // RtlCompareMemory(a, b, length) -> bytes iguais do inicio
        (pointerA, pointerB, length) => {
            let equal = 0;
            while (equal < length &&
                   GuestMemory.readGuest8(pointerA + equal) ===
                   GuestMemory.readGuest8(pointerB + equal))
                equal++;
            return equal;
        },
        // RtlUpcaseUnicodeString(dest, src, allocate): dest = src em maiusculas
        (destPointer, srcPointer, allocate) => {
            const text = GuestStrings.readUnicodeString(srcPointer).toUpperCase();
            return writeConvertedString(destPointer, text, allocate);
        },
        // RtlDowncaseUnicodeString(dest, src, allocate): minusculas
        (destPointer, srcPointer, allocate) => {
            const text = GuestStrings.readUnicodeString(srcPointer).toLowerCase();
            return writeConvertedString(destPointer, text, allocate);
        },
        // RtlPrefixUnicodeString(prefix, text, caseInsensitive) -> 1 se prefixo
        (prefixPointer, textPointer, caseInsensitive) => {
            let prefix = GuestStrings.readUnicodeString(prefixPointer);
            let text = GuestStrings.readUnicodeString(textPointer);
            if (caseInsensitive) {
                prefix = prefix.toLowerCase();
                text = text.toLowerCase();
            }
            return text.startsWith(prefix) ? 1 : 0;
        },
        // RtlAppendUnicodeStringToString(dest, src): concatena no buffer do dest
        (destPointer, srcPointer) => {
            const currentText = GuestStrings.readUnicodeString(destPointer);
            const suffixText = GuestStrings.readUnicodeString(srcPointer);
            return appendToUnicodeString(destPointer, currentText + suffixText);
        },
        // RtlAppendUnicodeToString(dest, wideStrPtr): concatena C-string wide
        (destPointer, wideStringPointer) => {
            const currentText = GuestStrings.readUnicodeString(destPointer);
            const suffixText = GuestStrings.readGuestWideString(wideStringPointer);
            return appendToUnicodeString(destPointer, currentText + suffixText);
        },
        // InterlockedPushEntryList(headPtr, entryPtr): SINGLE_LIST_ENTRY —
        // entry->Next = head->Next; head->Next = entry; retorna a antiga cabeca
        (headPointer, entryPointer) => {
            const oldHead = GuestMemory.readGuest64(headPointer);
            GuestMemory.writeGuest64(entryPointer, oldHead);
            GuestMemory.writeGuest64(headPointer, entryPointer);
            return oldHead;
        },
        // InterlockedPopEntryList(headPtr) -> entry ou 0 (lista vazia)
        (headPointer) => {
            const head = GuestMemory.readGuest64(headPointer);
            if (!head) return 0;
            GuestMemory.writeGuest64(headPointer, GuestMemory.readGuest64(head));
            return head;
        },
        // ExInterlockedInsertTailList(headPtr, entryPtr, spinLockPtr):
        // LIST_ENTRY circular dupla (Flink/Blink guardam ENDERECOS) sob
        // spinlock a DISPATCH_LEVEL
        (headPointer, entryPointer, spinLockPointer) => {
            const oldIrql = spinLockAcquire(spinLockPointer);
            const lastEntry = GuestMemory.readGuest64(headPointer + 8);   // Blink
            GuestMemory.writeGuest64(entryPointer, headPointer);      // Flink=sentinel
            GuestMemory.writeGuest64(entryPointer + 8, lastEntry);    // Blink=antigo ultimo
            GuestMemory.writeGuest64(lastEntry, entryPointer);        // ultimo->Flink=entry
            GuestMemory.writeGuest64(headPointer + 8, entryPointer);  // sentinel->Blink
            spinLockRelease(spinLockPointer, oldIrql);
            return lastEntry === headPointer ? 0 : lastEntry;   // 0 se estava vazia
        },
        // ExInterlockedRemoveHeadList(headPtr, spinLockPtr) -> entry ou 0
        (headPointer, spinLockPointer) => {
            const oldIrql = spinLockAcquire(spinLockPointer);
            const firstEntry = GuestMemory.readGuest64(headPointer);      // Flink
            let removed = 0;
            if (firstEntry !== headPointer) {   // nao vazia (Flink != sentinel)
                removed = firstEntry;
                const newFirst = GuestMemory.readGuest64(firstEntry);     // next
                GuestMemory.writeGuest64(headPointer, newFirst);
                GuestMemory.writeGuest64(newFirst + 8, headPointer);      // novo primeiro->Blink = sentinel
            }
            spinLockRelease(spinLockPointer, oldIrql);
            return removed;
        },
        // strlen(strPtr) -> comprimento
        (stringPointer) => GuestStrings.readGuestCString(stringPointer).length,
        // strcmp(a, b) -> <0/0/>0
        (pointerA, pointerB) => {
            const a = GuestStrings.readGuestCString(pointerA);
            const b = GuestStrings.readGuestCString(pointerB);
            return a < b ? -1 : a > b ? 1 : 0;
        },
        // strncmp(a, b, n)
        (pointerA, pointerB, count) => {
            const a = GuestStrings.readGuestCString(pointerA).slice(0, count);
            const b = GuestStrings.readGuestCString(pointerB).slice(0, count);
            return a < b ? -1 : a > b ? 1 : 0;
        },
        // strcpy(dest, src) -> dest
        (destPointer, srcPointer) => {
            const text = GuestStrings.readGuestCString(srcPointer);
            for (let i = 0; i <= text.length; i++)
                GuestMemory.writeGuest8(destPointer + i,
                                        i < text.length ? text.charCodeAt(i) : 0);
            return destPointer;
        },
        // strncpy(dest, src, n) -> dest
        (destPointer, srcPointer, count) => {
            const text = GuestStrings.readGuestCString(srcPointer);
            for (let i = 0; i < count; i++)
                GuestMemory.writeGuest8(destPointer + i,
                                        i < text.length ? text.charCodeAt(i) : 0);
            return destPointer;
        },
        // strcat(dest, src) -> dest
        (destPointer, srcPointer) => {
            const current = GuestStrings.readGuestCString(destPointer);
            const suffix = GuestStrings.readGuestCString(srcPointer);
            const combined = current + suffix;
            for (let i = 0; i <= combined.length; i++)
                GuestMemory.writeGuest8(destPointer + i,
                                        i < combined.length ? combined.charCodeAt(i) : 0);
            return destPointer;
        },
        // strchr(str, c) -> ponteiro p/ a 1a ocorrencia ou 0
        (stringPointer, character) => {
            const text = GuestStrings.readGuestCString(stringPointer);
            const index = text.indexOf(String.fromCharCode(character & 0xFF));
            return index < 0 ? 0 : stringPointer + index;
        },
        // strstr(str, sub) -> ponteiro p/ a 1a ocorrencia ou 0
        (stringPointer, substringPointer) => {
            const text = GuestStrings.readGuestCString(stringPointer);
            const needle = GuestStrings.readGuestCString(substringPointer);
            const index = text.indexOf(needle);
            return index < 0 ? 0 : stringPointer + index;
        },
        // sprintf(buf, fmt, ...) -> chars escritos (formatador do kernel)
        (bufferPointer, formatPointer, a1, a2, a3, a4, a5, a6) => {
            const text = GuestStrings.formatGuestText(
                GuestStrings.readGuestCString(formatPointer),
                [a1, a2, a3, a4, a5, a6]);
            for (let i = 0; i <= text.length; i++)
                GuestMemory.writeGuest8(bufferPointer + i,
                                        i < text.length ? text.charCodeAt(i) : 0);
            return text.length;
        },
        // snprintf(buf, size, fmt, ...) -> chars que seriam escritos
        (bufferPointer, bufferSize, formatPointer, a1, a2, a3, a4, a5) => {
            const text = GuestStrings.formatGuestText(
                GuestStrings.readGuestCString(formatPointer),
                [a1, a2, a3, a4, a5]);
            const writable = Math.min(text.length, (bufferSize >>> 0) - 1);
            for (let i = 0; i < writable; i++)
                GuestMemory.writeGuest8(bufferPointer + i, text.charCodeAt(i));
            if (bufferSize > 0)
                GuestMemory.writeGuest8(bufferPointer + writable, 0);
            return text.length;
        },
        // RtlRandomEx(seedPtr): LCG das constantes documentadas (VC/NT)
        (seedPointer) => {
            let seed = GuestMemory.readGuest32(seedPointer) >>> 0;
            seed = (seed * 214013 + 2531011) >>> 0;
            GuestMemory.writeGuest32(seedPointer, seed);
            return (seed >>> 16) & 0x7FFF;
        },
        // RtlRandom(seedPtr): idem (mesma familia documentada)
        (seedPointer) => {
            let seed = GuestMemory.readGuest32(seedPointer) >>> 0;
            seed = (seed * 214013 + 2531011) >>> 0;
            GuestMemory.writeGuest32(seedPointer, seed);
            return (seed >>> 16) & 0x7FFF;
        },
        // RtlVerifyVersionInfo(outVerInfo, typeMask, conditionMask u64):
        // OSVERSIONINFOEXW { size+0, Major+4, Minor+8, Build+12, Platform+16,
        // ServicePackMajor+0x2C... } — compara com nossa versao (10.0.19045)
        (versionInfoPointer, typeMask, conditionMask) => {
            const JSOS_VERSION = { major: 10, minor: 0, build: 19045, spMajor: 0 };
            const guestMajor = GuestMemory.readGuest32(versionInfoPointer + 4);
            const guestMinor = GuestMemory.readGuest32(versionInfoPointer + 8);
            const guestBuild = GuestMemory.readGuest32(versionInfoPointer + 12);
            const condition = conditionMask >= TWO_POW_63
                ? conditionMask - 0x10000000000000000 : conditionMask;
            // avalia cada campo marcado (VER_MAJOR=1, MINOR=2, BUILD=4)
            const checks = [];
            if (typeMask & 1) checks.push([guestMajor, JSOS_VERSION.major]);
            if (typeMask & 2) checks.push([guestMinor, JSOS_VERSION.minor]);
            if (typeMask & 4) checks.push([guestBuild, JSOS_VERSION.build]);
            for (const [expected, actual] of checks) {
                // conditionMask: blocos de 3 bits por campo (VER_EQUAL=1,
                // GREATER=2, LESS=4, GREATER_EQUAL=3, LESS_EQUAL=5)
                const op = condition & 7;
                const ok = op === 1 ? actual === expected :
                           op === 2 ? actual > expected :
                           op === 4 ? actual < expected :
                           op === 3 ? actual >= expected :
                           op === 5 ? actual <= expected : true;
                if (!ok) return 0xC0000428 | 0;  // STATUS_REVISION_MISMATCH
            }
            return 0;
        },
        // VerSetConditionMask(mask u64, typeMask, condition) -> u64 mascara
        (mask, typeMask, condition) => {
            const base = mask >= TWO_POW_63 ? mask - 0x10000000000000000 : mask;
            const shift = (typeMask >>> 0) * 3;   // aproximacao do algoritmo NT
            return base + ((condition >>> 0) * Math.pow(2, shift));
        },
        // RtlWriteRegistryValue(relativeTo, pathWStr, nameWStr, type, data, size)
        // — o primeiro arg e' RelativeTo (RTL_REGISTRY_ABSOLUTE etc.); path e
        // name sao PCWSTR (wide)
        (relativeTo, pathPointer, valueNamePointer, valueType, dataPointer,
         dataSize) => {
            // args 5+ chegam pela PILHA do convidado: o chamador (ABI MS) so
            // garante os 32 bits baixos de um ULONG — os 32 altos sao lixo.
            // TUDO que delimita loop/endereco precisa de >>> 0 aqui.
            const dataLength = dataSize >>> 0;
            const dataStart = dataPointer >>> 0;
            const keyPath = GuestStrings.readGuestWideString(pathPointer);
            const valueName = GuestStrings.readGuestWideString(valueNamePointer);
            const keyHandle = Registry.openOrCreate(keyPath);
            if (!keyHandle) return 0xC0000034 | 0;
            const data = [];
            for (let i = 0; i < dataLength; i++)
                data.push(GuestMemory.readGuest8(dataStart + i));
            const written = Registry.setValue(keyHandle, valueName,
                                              valueType >>> 0, data);
            Registry.closeHandle(keyHandle);
            return written ? 0 : 0xC0000034 | 0;
        },
        // RtlQueryRegistryValues(relativeTo, pathWStr, queryTablePtr,
        //                        contextPtr, environmentPtr)
        queryRegistryValues,
        // RtlQueryRegistryValuesEx: mesma assinatura/semantica (no NT a
        // versao sem Ex e' que chama esta)
        queryRegistryValues,
        // _vsnwprintf(buf, sizeChars, fmt, vaListPtr): wide printf com va_list
        // (x64: va_list = ponteiro p/ os args na pilha do chamador)
        (bufferPointer, bufferChars, formatPointer, vaListPointer) => {
            const formatText = GuestStrings.readGuestCString(formatPointer);
            const args = [];
            for (let i = 0; i < 8; i++)
                args.push(GuestMemory.readGuest64(vaListPointer + i * 8));
            const text = GuestStrings.formatGuestText(formatText, args);
            const writable = Math.min(text.length, (bufferChars >>> 0) - 1);
            for (let i = 0; i < writable; i++)
                GuestMemory.writeGuest16(bufferPointer + i * 2,
                                         text.charCodeAt(i));
            if (bufferChars > 0)
                GuestMemory.writeGuest16(bufferPointer + writable * 2, 0);
            return writable;
        },
    ],
};
