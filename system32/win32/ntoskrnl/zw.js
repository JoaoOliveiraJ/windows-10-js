// ===========================================================================
// jsOS - system32/win32/ntoskrnl/zw.js: exports Zw* (Registry) com os
// layouts reais do NT (OBJECT_ATTRIBUTES @ win32/nt-abi.js,
// KEY_VALUE_PARTIAL_INFORMATION idem). Configuration Manager: ntos/cm/.
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const Registry = require('ntos/cm/registry');
const ObjectManager = require('ntos/ob/object-manager');

const STATUS_NOT_FOUND = 0xC0000009;
const STATUS_BUFFER_TOO_SMALL = 0xC0000023;
const STATUS_INVALID_HANDLE = 0xC0000008;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;
const STATUS_END_OF_FILE = 0xC0000011;
const STATUS_MEDIA_WRITE_PROTECTED = 0xC00000A2;

function keyPathFromObjectAttributes(objectAttributesPointer) {
    const namePointer = GuestMemory.readGuest32(objectAttributesPointer +
                                                NtAbi.OBJECT_ATTRIBUTES.OBJECT_NAME);
    return GuestStrings.readUnicodeString(namePointer);
}

// ---- I/O de arquivos em modo kernel (ZwCreateFile/ZwReadFile/ZwWriteFile) --
// Resolve o caminho no namespace (links \DosDevices\C:/D: incluidos) ate um
// FS montado (\FS ramfs ou \NTFS disco) e faz a operacao de verdade nele.

let nextFileHandle = 0x1000;
const fileHandles = new Map();   // handle -> { fs, fsPath }

// FILE_* dispositions (wdm.h)
const FILE_OPEN = 1, FILE_CREATE = 2, FILE_OPEN_IF = 3,
      FILE_OVERWRITE = 4, FILE_OVERWRITE_IF = 5;
// IoStatusBlock.Information (wdm.h)
const FILE_SUPERSEDED = 0, FILE_OPENED = 1, FILE_CREATED = 2,
      FILE_OVERWRITTEN = 3, FILE_EXISTS = 4;

function writeIoStatus(ioStatusPointer, status, information) {
    GuestMemory.writeGuest32(ioStatusPointer + NtAbi.IO_STATUS_BLOCK.STATUS,
                             status >>> 0);
    GuestMemory.writeGuest64(ioStatusPointer + NtAbi.IO_STATUS_BLOCK.INFORMATION,
                             information);
}

function resolveMountedFile(objectName) {
    const resolved = ObjectManager.resolve(objectName);
    if (!resolved.node || !resolved.node.mount) return null;
    return { fs: resolved.node.mount, fsPath: '/' + resolved.rest };
}

// conteudo do arquivo como array de bytes (ramfs guarda texto OU ArrayBuffer)
function readFileBytes(fs, fsPath) {
    if (fs.readBytes) {
        const binary = fs.readBytes(fsPath);
        if (binary) return Array.from(new Uint8Array(binary));
    }
    const text = fs.read(fsPath);
    if (text === null || text === undefined) return null;
    return Array.from(String(text), c => c.charCodeAt(0) & 0xFF);
}

function writeFileBytes(fs, fsPath, bytes) {
    // ramfs: armazena como texto (subconjunto documentado; o NTFS e read-only)
    fs.write(fsPath, String.fromCharCode(...bytes));
}

// ZwCreateFile(handleOut, access, objAttrs, ioStatus, allocSize, fileAttrs,
//              shareAccess, createDisposition, createOptions, eaBuf, eaLen)
function zwCreateFile(outHandlePointer, _desiredAccess, objectAttributesPointer,
                      ioStatusPointer, _allocationSize, _fileAttributes,
                      _shareAccess, createDisposition, _createOptions,
                      _eaBuffer, _eaLength) {
    const objectName = keyPathFromObjectAttributes(objectAttributesPointer);
    const target = resolveMountedFile(objectName);
    if (!target) {
        writeIoStatus(ioStatusPointer, STATUS_OBJECT_NAME_NOT_FOUND, 0);
        return STATUS_OBJECT_NAME_NOT_FOUND;
    }
    const { fs, fsPath } = target;
    const exists = !!fs.exists(fsPath);
    const writable = typeof fs.write === 'function';
    const disposition = createDisposition >>> 0;

    let information = FILE_OPENED;
    if (disposition === FILE_OPEN) {
        if (!exists) {
            writeIoStatus(ioStatusPointer, STATUS_OBJECT_NAME_NOT_FOUND, 0);
            return STATUS_OBJECT_NAME_NOT_FOUND;
        }
    } else if (disposition === FILE_CREATE) {
        if (exists) information = FILE_EXISTS;
        else {
            if (!writable) return STATUS_MEDIA_WRITE_PROTECTED | 0;
            writeFileBytes(fs, fsPath, []);
            information = FILE_CREATED;
        }
    } else if (disposition === FILE_OPEN_IF) {
        if (!exists) {
            if (!writable) return STATUS_MEDIA_WRITE_PROTECTED | 0;
            writeFileBytes(fs, fsPath, []);
            information = FILE_CREATED;
        }
    } else if (disposition === FILE_OVERWRITE || disposition === FILE_OVERWRITE_IF) {
        if (!writable) return STATUS_MEDIA_WRITE_PROTECTED | 0;
        if (disposition === FILE_OVERWRITE && !exists) {
            writeIoStatus(ioStatusPointer, STATUS_OBJECT_NAME_NOT_FOUND, 0);
            return STATUS_OBJECT_NAME_NOT_FOUND;
        }
        writeFileBytes(fs, fsPath, []);
        information = exists ? FILE_OVERWRITTEN : FILE_CREATED;
    } else {
        return 0xC000000D | 0;   // STATUS_INVALID_PARAMETER
    }

    const handle = nextFileHandle++;
    fileHandles.set(handle, { fs, fsPath });
    GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
    GuestMemory.writeGuest32(outHandlePointer + 4, 0);
    writeIoStatus(ioStatusPointer, 0, information);
    return 0;
}

// ZwReadFile(handle, event, apc, apcCtx, ioStatus, buffer, length, offsetPtr, key)
function zwReadFile(fileHandle, _event, _apcRoutine, _apcContext, ioStatusPointer,
                    bufferPointer, length, byteOffsetPointer, _key) {
    const entry = fileHandles.get(fileHandle >>> 0);
    if (!entry) return STATUS_INVALID_HANDLE | 0;
    const bytes = readFileBytes(entry.fs, entry.fsPath);
    if (bytes === null) return STATUS_OBJECT_NAME_NOT_FOUND | 0;
    let offset = 0;
    if (byteOffsetPointer) {
        offset = GuestMemory.readGuest32(byteOffsetPointer) +
                 GuestMemory.readGuest32(byteOffsetPointer + 4) * 0x100000000;
    }
    if (offset >= bytes.length) {
        writeIoStatus(ioStatusPointer, STATUS_END_OF_FILE, 0);
        return STATUS_END_OF_FILE | 0;
    }
    const count = Math.min(length >>> 0, bytes.length - offset);
    for (let i = 0; i < count; i++)
        GuestMemory.writeGuest8(bufferPointer + i, bytes[offset + i]);
    writeIoStatus(ioStatusPointer, 0, count);
    return 0;
}

// ZwWriteFile(handle, event, apc, apcCtx, ioStatus, buffer, length, offsetPtr, key)
function zwWriteFile(fileHandle, _event, _apcRoutine, _apcContext, ioStatusPointer,
                     bufferPointer, length, byteOffsetPointer, _key) {
    const entry = fileHandles.get(fileHandle >>> 0);
    if (!entry) return STATUS_INVALID_HANDLE | 0;
    if (typeof entry.fs.write !== 'function')
        return STATUS_MEDIA_WRITE_PROTECTED | 0;
    const current = readFileBytes(entry.fs, entry.fsPath) || [];
    let offset = 0;
    if (byteOffsetPointer) {
        offset = GuestMemory.readGuest32(byteOffsetPointer) +
                 GuestMemory.readGuest32(byteOffsetPointer + 4) * 0x100000000;
    }
    while (current.length < offset) current.push(0);
    for (let i = 0; i < (length >>> 0); i++)
        current[offset + i] = GuestMemory.readGuest8(bufferPointer + i);
    writeFileBytes(entry.fs, entry.fsPath, current);
    writeIoStatus(ioStatusPointer, 0, length >>> 0);
    return 0;
}

module.exports = {
    names: [
        'ZwCreateKey',
        'ZwOpenKey',
        'ZwSetValueKey',
        'ZwQueryValueKey',
        'ZwClose',
        'ZwCreateFile',
        'ZwReadFile',
        'ZwWriteFile',
        'ZwEnumerateKey',
        'ZwEnumerateValueKey',
        'ZwDeleteKey',
        'ZwQueryFullAttributesFile',
    ],
    handlers: [
        // ZwCreateKey(outHandlePtr, access, objAttrsPtr, ...) -> NTSTATUS
        (outHandlePointer, _access, objectAttributesPointer) => {
            const keyPath = keyPathFromObjectAttributes(objectAttributesPointer);
            const handle = Registry.openOrCreate(keyPath);
            if (!handle) return STATUS_NOT_FOUND;
            GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
            GuestMemory.writeGuest32(outHandlePointer + 4, 0);
            return 0;
        },
        // ZwOpenKey(outHandlePtr, access, objAttrsPtr)
        (outHandlePointer, _access, objectAttributesPointer) => {
            const keyPath = keyPathFromObjectAttributes(objectAttributesPointer);
            const handle = Registry.open(keyPath);
            if (!handle) return STATUS_NOT_FOUND;
            GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
            GuestMemory.writeGuest32(outHandlePointer + 4, 0);
            return 0;
        },
        // ZwSetValueKey(handle, valueNameUniPtr, titleIndex, type, dataPtr, dataSize)
        (keyHandle, valueNamePointer, _titleIndex, valueType, dataPointer, dataSize) => {
            const valueName = GuestStrings.readUnicodeString(valueNamePointer);
            const data = [];
            for (let i = 0; i < dataSize; i++)
                data.push(GuestMemory.readGuest8(dataPointer + i));
            return Registry.setValue(keyHandle, valueName, valueType, data)
                ? 0 : STATUS_NOT_FOUND;
        },
        // ZwQueryValueKey(handle, valueNameUniPtr, infoClass, outBufPtr, bufSize, outLenPtr)
        // KEY_VALUE_PARTIAL_INFORMATION: +0 TitleIndex +4 Type +8 DataLength +12 Data
        (keyHandle, valueNamePointer, _infoClass, outBufferPointer, bufferSize,
         outLengthPointer) => {
            const valueName = GuestStrings.readUnicodeString(valueNamePointer);
            const entry = Registry.getValue(keyHandle, valueName);
            const KV = NtAbi.KEY_VALUE_PARTIAL;
            if (!entry) return STATUS_NOT_FOUND;
            if (bufferSize < KV.DATA + entry.data.length) {
                GuestMemory.writeGuest32(outLengthPointer, KV.DATA + entry.data.length);
                return STATUS_BUFFER_TOO_SMALL;
            }
            GuestMemory.writeGuest32(outBufferPointer + KV.TITLE_INDEX, 0);
            GuestMemory.writeGuest32(outBufferPointer + KV.TYPE, entry.type);
            GuestMemory.writeGuest32(outBufferPointer + KV.DATA_LENGTH, entry.data.length);
            for (let i = 0; i < entry.data.length; i++)
                GuestMemory.writeGuest8(outBufferPointer + KV.DATA + i, entry.data[i]);
            GuestMemory.writeGuest32(outLengthPointer, KV.DATA + entry.data.length);
            return 0;
        },
        // ZwClose(handle): fecha handle de arquivo OU de chave de registry
        (anyHandle) => {
            if (fileHandles.delete(anyHandle >>> 0)) return 0;
            return Registry.closeHandle(anyHandle) ? 0 : STATUS_INVALID_HANDLE;
        },
        // ZwCreateFile(handleOut, access, objAttrs, ioStatus, allocSize,
        //              fileAttrs, share, createDisposition, createOptions, ea, eaLen)
        zwCreateFile,
        // ZwReadFile(handle, event, apc, apcCtx, ioStatus, buffer, len, offPtr, key)
        zwReadFile,
        // ZwWriteFile(idem)
        zwWriteFile,
        // ZwEnumerateKey(handle, index, KeyBasicInformation, outBuf, size, outLen)
        // KEY_BASIC_INFORMATION: +0 LastWriteTime u64, +8 TitleIndex, +12 NameLength, +16 Name
        (keyHandle, index, _infoClass, outBufferPointer, bufferSize, outLengthPointer) => {
            const node = Registry.getNode(keyHandle >>> 0);
            if (!node) return STATUS_INVALID_HANDLE | 0;
            const children = [...node.children.values()];
            if ((index >>> 0) >= children.length) return 0x8000001A | 0;  // NO_MORE_ENTRIES
            const name = children[index >>> 0].name;
            const needed = 0x10 + name.length * 2;
            if (bufferSize < needed) {
                GuestMemory.writeGuest32(outLengthPointer, needed);
                return STATUS_BUFFER_TOO_SMALL | 0;
            }
            GuestMemory.writeGuest64(outBufferPointer, 0);            // LastWriteTime
            GuestMemory.writeGuest32(outBufferPointer + 8, 0);        // TitleIndex
            GuestMemory.writeGuest32(outBufferPointer + 12, name.length * 2);
            for (let i = 0; i < name.length; i++)
                GuestMemory.writeGuest16(outBufferPointer + 16 + i * 2,
                                         name.charCodeAt(i));
            GuestMemory.writeGuest32(outLengthPointer, needed);
            return 0;
        },
        // ZwEnumerateValueKey(handle, index, KeyValueBasicInformation, out, size, outLen)
        // KEY_VALUE_BASIC_INFORMATION: +0 TitleIndex, +4 Type, +8 NameLength, +12 Name
        (keyHandle, index, _infoClass, outBufferPointer, bufferSize, outLengthPointer) => {
            const node = Registry.getNode(keyHandle >>> 0);
            if (!node) return STATUS_INVALID_HANDLE | 0;
            const values = [...node.values.values()];
            if ((index >>> 0) >= values.length) return 0x8000001A | 0;
            const entry = values[index >>> 0];
            const needed = 12 + entry.name.length * 2;
            if (bufferSize < needed) {
                GuestMemory.writeGuest32(outLengthPointer, needed);
                return STATUS_BUFFER_TOO_SMALL | 0;
            }
            GuestMemory.writeGuest32(outBufferPointer, 0);
            GuestMemory.writeGuest32(outBufferPointer + 4, entry.type);
            GuestMemory.writeGuest32(outBufferPointer + 8, entry.name.length * 2);
            for (let i = 0; i < entry.name.length; i++)
                GuestMemory.writeGuest16(outBufferPointer + 12 + i * 2,
                                         entry.name.charCodeAt(i));
            GuestMemory.writeGuest32(outLengthPointer, needed);
            return 0;
        },
        // ZwDeleteKey(handle): remove a chave da hive de verdade
        (keyHandle) => Registry.deleteKey(keyHandle >>> 0)
            ? 0 : STATUS_INVALID_HANDLE | 0,
        // ZwQueryFullAttributesFile(objAttrs, out FILE_BASIC_INFORMATION):
        // +0x00..0x18 tempos (100ns desde 1601), +0x20 FileAttributes
        (objectAttributesPointer, outBufferPointer) => {
            const objectName = keyPathFromObjectAttributes(objectAttributesPointer);
            const target = resolveMountedFile(objectName);
            if (!target || !target.fs.exists(target.fsPath))
                return STATUS_OBJECT_NAME_NOT_FOUND | 0;
            const ntTimeNow = (Date.now() + 11644473600000) * 10000;
            for (let field = 0; field < 4; field++) {
                GuestMemory.writeGuest32(outBufferPointer + field * 8,
                                         ntTimeNow % 0x100000000);
                GuestMemory.writeGuest32(outBufferPointer + field * 8 + 4,
                                         Math.floor(ntTimeNow / 0x100000000));
            }
            GuestMemory.writeGuest32(outBufferPointer + 0x20, 0x80);  // NORMAL
            return 0;
        },
    ],
};
