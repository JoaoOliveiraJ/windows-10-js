// ===========================================================================
// jsOS - system32/win32/ntoskrnl/rtl.js: exports Rtl* + Interlocked* (com a
// semantica real do NT sobre a memoria do convidado).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const Registry = require('ntos/cm/registry');
const NtAbi = require('win32/nt-abi');
const Irql = require('ntos/ke/irql');
const ZwExports = require('win32/ntoskrnl/zw');

// prefixos RTL_REGISTRY_* (RtlCreateRegistryKey/RtlDeleteRegistryValue): o
// path relativo ganha a base absoluta — sem control sets no jsOS (Services/
// Control direto sob System, como o resto do kernel faz)
const RTL_REGISTRY_PREFIX = {
    1: '\\Registry\\Machine\\System\\Services\\',
    2: '\\Registry\\Machine\\System\\Control\\',
    3: '\\Registry\\Machine\\Software\\Microsoft\\Windows NT\\CurrentVersion\\',
    4: '\\Registry\\Machine\\Hardware\\DeviceMap\\',
    5: '\\Registry\\User\\.CurrentUser\\',
};

function rtlRegistryPath(relativeTo, rawPath) {
    if (relativeTo === 0) return rawPath;   // RTL_REGISTRY_ABSOLUTE
    const prefix = RTL_REGISTRY_PREFIX[relativeTo];
    if (!prefix) return rawPath;
    return prefix + rawPath.replace(/^\\+/, '');
}

// notificacoes de mudanca de feature (RtlRegisterFeatureConfigurationChange...)
const featureConfigurationNotifications = [];

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
        '_wcsupr',                         // uppercase wide in-place
        '__C_specific_handler',            // despachante SEH da CRT
        'RtlInitializeBitMap',             // (bitmap, buffer, sizeBits)
        'RtlSetAllBits',                   // (bitmap)
        'RtlClearBits',                    // (bitmap)
        'RtlClearBit',                     // (bitmap, bit)
        'RtlFindClearBitsAndSet',          // (bitmap, count, hint) -> idx
        'RtlInitString',                   // (destString, srcCString)
        'RtlStringFromGUID',               // (guid, outUni) -> NTSTATUS
        'RtlDuplicateUnicodeString',       // (alloc, src, dest)
        'RtlCreateRegistryKey',            // (relativeTo, pathWide)
        'RtlDeleteRegistryValue',          // (relativeTo, pathWide, nameWide)
        'RtlGetVersion',                   // (outVersionInfo)
        'RtlQueryFeatureConfiguration',    // (id, type, stamp, buf, size)
        'RtlQueryFeatureConfigurationChangeStamp',
        'RtlRegisterFeatureConfigurationChangeNotification',
        'RtlUnregisterFeatureConfigurationChangeNotification',
        'RtlTimeToTimeFields',             // (timePtr, outTimeFields)
        'RtlUpcaseUnicodeChar',            // (wchar) -> upper
        'RtlxAnsiStringToUnicodeSize',     // (ansiString) -> bytes
        'RtlCreateSystemVolumeInformationFolder', // (volumeRootUni)
        '_strupr',                         // uppercase ANSI in-place
        '_vsnprintf',                      // (buf, count, fmt, vaList)
        'vDbgPrintExWithPrefix',           // (prefix, compId, level, fmt, vaList)
        'wcsstr',                          // (haystackW, needleW) -> ptr
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
        // (x64: va_list = ponteiro p/ os args na pilha do chamador). O formato
        // e' WIDE (UTF-16) — ler como C-string truncaria no 1o byte nulo alto.
        (bufferPointer, bufferChars, formatPointer, vaListPointer) => {
            const formatText = GuestStrings.readGuestWideString(formatPointer);
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
        // _wcsupr(wstrPtr): uppercase in-place (mapeamento 1:1 por wchar,
        // como o CRT do Windows — sem expansao tipo ss<-ß)
        (wideStringPointer) => {
            let cursor = wideStringPointer >>> 0;
            for (;;) {
                const unit = GuestMemory.readGuest16(cursor);
                if (unit === 0) break;
                const upper = String.fromCharCode(unit).toUpperCase();
                GuestMemory.writeGuest16(cursor, upper.charCodeAt(0));
                cursor += 2;
            }
            return wideStringPointer;
        },
        // __C_specific_handler: o despachante SEH da CRT — so e' chamado se
        // uma excecao estruturada ocorre dentro do driver. Sem frames SEH
        // registrados, o desfecho real no NT e' KMODE_EXCEPTION_NOT_HANDLED.
        (exceptionRecordPointer, _establisherFrame, _contextRecordPointer,
         _dispatcherContext) => {
            const exceptionCode = exceptionRecordPointer
                ? GuestMemory.readGuest32(exceptionRecordPointer) : 0;
            os.debugPrint('[seh] excecao 0x' + (exceptionCode >>> 0).toString(16) +
                          ' em codigo de driver sem tratamento — bugcheck');
            os.halt();
            return 0;
        },
        // ---- RTL_BITMAP real { u32 SizeOfBitMap; pad; u64 BufferPtr } ----
        // RtlInitializeBitMap(bitmap, buffer, sizeInBits)
        (bitmapPointer, bufferPointer, sizeInBits) => {
            GuestMemory.writeGuest32(bitmapPointer, sizeInBits >>> 0);
            GuestMemory.writeGuest64(bitmapPointer + 8, bufferPointer);
            return 0;
        },
        // RtlSetAllBits(bitmap): todos os bits em 1
        (bitmapPointer) => {
            const sizeInBits = GuestMemory.readGuest32(bitmapPointer);
            const buffer = GuestMemory.readGuest64(bitmapPointer + 8);
            for (let i = 0; i < Math.ceil(sizeInBits / 32); i++)
                GuestMemory.writeGuest32(buffer + i * 4, 0xFFFFFFFF);
            return 0;
        },
        // RtlClearBits(bitmap): todos os bits em 0
        (bitmapPointer) => {
            const sizeInBits = GuestMemory.readGuest32(bitmapPointer);
            const buffer = GuestMemory.readGuest64(bitmapPointer + 8);
            for (let i = 0; i < Math.ceil(sizeInBits / 32); i++)
                GuestMemory.writeGuest32(buffer + i * 4, 0);
            return 0;
        },
        // RtlClearBit(bitmap, bitNumber)
        (bitmapPointer, bitNumber) => {
            const buffer = GuestMemory.readGuest64(bitmapPointer + 8);
            const wordIndex = (bitNumber >>> 0) >> 5;
            const word = GuestMemory.readGuest32(buffer + wordIndex * 4);
            GuestMemory.writeGuest32(buffer + wordIndex * 4,
                                     word & ~(1 << (bitNumber & 31)));
            return 0;
        },
        // RtlFindClearBitsAndSet(bitmap, numberToFind, hintIndex) -> indice do
        // run de bits limpos (marcados aqui) ou 0xFFFFFFFF
        (bitmapPointer, numberToFind, hintIndex) => {
            const sizeInBits = GuestMemory.readGuest32(bitmapPointer);
            const buffer = GuestMemory.readGuest64(bitmapPointer + 8);
            const testBit = (bit) =>
                (GuestMemory.readGuest32(buffer + (bit >> 5) * 4) >>> (bit & 31)) & 1;
            const setBit = (bit) => {
                const wordOffset = (bit >> 5) * 4;
                GuestMemory.writeGuest32(buffer + wordOffset,
                    GuestMemory.readGuest32(buffer + wordOffset) | (1 << (bit & 31)));
            };
            for (let start = hintIndex >>> 0;
                 start + numberToFind <= sizeInBits; start++) {
                let run = 0;
                while (run < numberToFind && !testBit(start + run)) run++;
                if (run === numberToFind) {
                    for (let bit = start; bit < start + run; bit++) setBit(bit);
                    return start;
                }
            }
            return 0xFFFFFFFF;
        },
        // RtlInitString(destStringPtr, srcCStringPtr): STRING ANSI (Length
        // sem o NUL, MaximumLength com)
        (destStringPointer, sourceStringPointer) => {
            const text = sourceStringPointer
                ? GuestStrings.readGuestCString(sourceStringPointer) : '';
            GuestMemory.writeGuest16(destStringPointer, text.length);
            GuestMemory.writeGuest16(destStringPointer + 2, text.length + 1);
            GuestMemory.writeGuest64(destStringPointer + 8,
                                     sourceStringPointer >>> 0);
            return 0;
        },
        // RtlStringFromGUID(guidPtr, outUniPtr): formata o GUID no formato
        // canonico wide {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} (campos 1-3
        // little-endian no binario) em buffer de pool
        (guidPointer, outUnicodePointer) => {
            const hex = (value, width) =>
                (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
            const data1 = GuestMemory.readGuest32(guidPointer);
            const data2 = GuestMemory.readGuest16(guidPointer + 4);
            const data3 = GuestMemory.readGuest16(guidPointer + 6);
            let text = '{' + hex(data1, 8) + '-' + hex(data2, 4) + '-' +
                       hex(data3, 4) + '-';
            for (let i = 0; i < 2; i++)
                text += hex(GuestMemory.readGuest8(guidPointer + 8 + i), 2);
            text += '-';
            for (let i = 2; i < 8; i++)
                text += hex(GuestMemory.readGuest8(guidPointer + 8 + i), 2);
            text += '}';
            const buffer = GuestMemory.guestAllocBytes(text.length * 2 + 2);
            GuestStrings.writeGuestWideString(buffer, text);
            GuestMemory.writeGuest16(outUnicodePointer, text.length * 2);
            GuestMemory.writeGuest16(outUnicodePointer + 2, text.length * 2 + 2);
            GuestMemory.writeGuest64(outUnicodePointer + 8, buffer);
            return 0;
        },
        // RtlDuplicateUnicodeString(alloc, source, dest) -> NTSTATUS
        (allocateNewString, sourcePointer, destPointer) => {
            const length = GuestMemory.readGuest16(sourcePointer);
            const sourceBuffer = GuestMemory.readGuest64(sourcePointer + 8);
            let destBuffer;
            if (allocateNewString) {
                destBuffer = GuestMemory.guestAllocBytes(length + 2);
                GuestMemory.writeGuest16(destPointer + 2, length + 2);
            } else {
                destBuffer = GuestMemory.readGuest64(destPointer + 8);
                if (GuestMemory.readGuest16(destPointer + 2) < length)
                    return 0xC0000023 | 0;   // STATUS_BUFFER_TOO_SMALL
            }
            for (let i = 0; i < length; i++)
                GuestMemory.writeGuest8(destBuffer + i,
                                        GuestMemory.readGuest8(sourceBuffer + i));
            GuestMemory.writeGuest16(destPointer, length);
            GuestMemory.writeGuest64(destPointer + 8, destBuffer);
            return 0;
        },
        // RtlCreateRegistryKey(relativeTo, pathWidePtr): cria a chave com o
        // prefixo do RTL_REGISTRY_* (ABSOLUTE ja' vem completo)
        (relativeTo, pathPointer) => {
            const relativeBase = relativeTo & 0xFFFF;
            const rawPath = GuestStrings.readGuestWideString(pathPointer);
            const fullPath = rtlRegistryPath(relativeBase, rawPath);
            const keyHandle = Registry.openOrCreate(fullPath);
            if (!keyHandle) return 0xC0000034 | 0;
            Registry.closeHandle(keyHandle);
            return 0;
        },
        // RtlDeleteRegistryValue(relativeTo, pathWidePtr, valueNameWidePtr)
        (relativeTo, pathPointer, valueNamePointer) => {
            const relativeBase = relativeTo & 0xFFFF;
            const rawPath = GuestStrings.readGuestWideString(pathPointer);
            const valueName = GuestStrings.readGuestWideString(valueNamePointer);
            const keyHandle = Registry.open(rtlRegistryPath(relativeBase, rawPath));
            if (!keyHandle) return 0xC0000034 | 0;
            const removed = Registry.deleteValue(keyHandle, valueName);
            Registry.closeHandle(keyHandle);
            return removed ? 0 : 0xC0000034 | 0;
        },
        // RtlGetVersion(outVersionInfoPtr): RTL_OSVERSIONINFOEXW — a versao
        // que implementamos (10.0.19045, Win10 22H2, como o PsGetVersion)
        (versionInfoPointer) => {
            GuestMemory.writeGuest32(versionInfoPointer + 4, 10);   // Major
            GuestMemory.writeGuest32(versionInfoPointer + 8, 0);    // Minor
            GuestMemory.writeGuest32(versionInfoPointer + 12, 19045); // Build
            GuestMemory.writeGuest32(versionInfoPointer + 16, 2);   // VER_PLATFORM_WIN32_NT
            GuestMemory.writeGuest16(versionInfoPointer + 0x114, 0x100); // SuiteMask
            GuestMemory.writeGuest8(versionInfoPointer + 0x116, 1); // VER_NT_WORKSTATION
            return 0;
        },
        // Feature configuration: nenhuma feature registrada no sistema — a
        // resposta REAL do NT para feature desconhecida e' STATUS_NOT_FOUND
        // (o driver cai no caminho default, como num Windows sem a feature)
        (_featureId, _changeStampType, _changeStampPointer, _configBuffer,
         _configBufferSize) => 0xC0000225 | 0,   // STATUS_NOT_FOUND
        // RtlQueryFeatureConfigurationChangeStamp() -> u64: 0 (nada mudou)
        () => 0,
        // RtlRegisterFeatureConfigurationChangeNotification(callback, ctx,
        // outHandlePtr): registra de verdade; a notificacao dispararia numa
        // mudanca de feature (nenhuma hoje — registrar e' o comportamento real)
        (callbackPointer, contextPointer, outHandlePointer) => {
            featureConfigurationNotifications.push(
                { callbackPointer: callbackPointer >>> 0,
                  contextPointer: contextPointer >>> 0 });
            if (outHandlePointer)
                GuestMemory.writeGuest64(outHandlePointer,
                                         callbackPointer >>> 0);
            return 0;
        },
        // RtlUnregisterFeatureConfigurationChangeNotification(handle)
        (handlePointer) => {
            const index = featureConfigurationNotifications.findIndex(
                entry => entry.callbackPointer === (handlePointer >>> 0));
            if (index < 0) return 0xC0000225 | 0;
            featureConfigurationNotifications.splice(index, 1);
            return 0;
        },
        // RtlTimeToTimeFields(timePtr u64 FILETIME, outTimeFieldsPtr):
        // conversao civil real (algoritmo de dias-desde-1601; weekday: 1601-
        // 01-01 foi segunda — no NT domingo=0, entao ((dias+1)%7))
        (timePointer, timeFieldsPointer) => {
            const filetime = GuestMemory.readGuest64(timePointer);
            const totalSeconds = Math.floor(filetime / 10000000);
            const days = Math.floor(totalSeconds / 86400);
            const secondsOfDay = totalSeconds % 86400;
            // civil_from_days (Howard Hinnant) com epoca em 1601-01-01
            const z = days + 719468;
            const era = Math.floor(z / 146097);
            const dayOfEra = z - era * 146097;
            const yearOfEra = Math.floor(
                (dayOfEra - Math.floor(dayOfEra / 1460) +
                 Math.floor(dayOfEra / 36524) -
                 Math.floor(dayOfEra / 146096)) / 365);
            const year = yearOfEra + era * 400;
            const dayOfYear = dayOfEra - (365 * yearOfEra +
                Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
            const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
            const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
            const month = monthPrime + (monthPrime < 10 ? 3 : -9);
            const fullYear = year + (month <= 2 ? 1 : 0);
            const fields = [fullYear, month, day,
                            Math.floor(secondsOfDay / 3600),
                            Math.floor((secondsOfDay % 3600) / 60),
                            secondsOfDay % 60,
                            Math.floor((filetime % 10000000) / 10000),
                            (days + 1) % 7];
            for (let i = 0; i < 8; i++)
                GuestMemory.writeGuest16(timeFieldsPointer + i * 2, fields[i]);
            return 0;
        },
        // RtlUpcaseUnicodeChar(wchar) -> maiuscula (ASCII + Latin-1 basico)
        (character) => {
            const code = character & 0xFFFF;
            if (code >= 0x61 && code <= 0x7A) return code - 0x20;
            if (code >= 0xE0 && code <= 0xFE && code !== 0xF7) return code - 0x20;
            return code;
        },
        // RtlxAnsiStringToUnicodeSize(ansiStringPtr) -> bytes wide com NUL
        (ansiStringPointer) => {
            const length = GuestMemory.readGuest16(ansiStringPointer);
            return (length + 1) * 2;
        },
        // RtlCreateSystemVolumeInformationFolder(volumeRootUniPtr): cria a
        // pasta "System Volume Information" no volume (FILE_DIRECTORY_FILE |
        // OPEN_IF, atributos SYSTEM|HIDDEN) pelo caminho real do ZwCreateFile
        (volumeRootPointer) => {
            const volumePath = GuestStrings.readUnicodeString(volumeRootPointer);
            const folderPath = volumePath +
                (volumePath.endsWith('\\') ? '' : '\\') +
                'System Volume Information';
            const status = ZwExports.createFileByName(
                folderPath, 3 /* FILE_OPEN_IF */, 1 /* FILE_DIRECTORY_FILE */,
                0x6 /* SYSTEM|HIDDEN */);
            if (status !== 0)
                os.debugPrint('[rtl] System Volume Information em ' + volumePath +
                              ' -> 0x' + (status >>> 0).toString(16));
            return status;
        },
        // _strupr(strPtr): uppercase ASCII in-place; retorna o ponteiro
        (stringPointer) => {
            let cursor = stringPointer >>> 0;
            for (;;) {
                const byte = GuestMemory.readGuest8(cursor);
                if (byte === 0) break;
                if (byte >= 0x61 && byte <= 0x7A)
                    GuestMemory.writeGuest8(cursor, byte - 0x20);
                cursor++;
            }
            return stringPointer;
        },
        // _vsnprintf(buf, count, fmt, vaListPtr): printf ANSI com va_list
        // real (x64: ponteiro p/ os args na pilha do chamador)
        (bufferPointer, count, formatPointer, vaListPointer) => {
            const formatText = GuestStrings.readGuestCString(formatPointer);
            const args = [];
            for (let i = 0; i < 8; i++)
                args.push(GuestMemory.readGuest64(vaListPointer + i * 8));
            const text = GuestStrings.formatGuestText(formatText, args);
            const writable = Math.min(text.length, (count >>> 0) - 1);
            for (let i = 0; i < writable; i++)
                GuestMemory.writeGuest8(bufferPointer + i, text.charCodeAt(i));
            if (count > 0)
                GuestMemory.writeGuest8(bufferPointer + writable, 0);
            return writable;
        },
        // vDbgPrintExWithPrefix(prefixPtr, componentId, level, fmt, vaList):
        // formata ANSI com va_list e loga com o prefixo (estilo WPP/ETW)
        (prefixPointer, _componentId, _level, formatPointer, vaListPointer) => {
            const prefix = prefixPointer
                ? GuestStrings.readGuestCString(prefixPointer) : '';
            const formatText = GuestStrings.readGuestCString(formatPointer);
            const args = [];
            for (let i = 0; i < 8; i++)
                args.push(GuestMemory.readGuest64(vaListPointer + i * 8));
            const text = GuestStrings.formatGuestText(formatText, args);
            os.debugPrint(prefix + text.replace(/\r?\n$/, ''));
            return 0;
        },
        // wcsstr(haystackWide, needleWide) -> ponteiro da 1a ocorrencia ou 0
        (haystackPointer, needlePointer) => {
            const haystack = GuestStrings.readGuestWideString(haystackPointer);
            const needle = GuestStrings.readGuestWideString(needlePointer);
            const index = haystack.indexOf(needle);
            return index < 0 ? 0 : haystackPointer + index * 2;
        },
    ],
};
