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
const IoManager = require('ntos/io/io-manager');
const Lifecycle = require('win32/ntoskrnl/lifecycle');
const Process = require('ntos/ps/process');
const Dispatcher = require('ntos/ke/dispatcher');

// handles de OBJETOS de kernel abertos via Zw (eventos, diretorios, links):
// handle -> { kind, node, dataPointer } (o fileHandles acima e' de arquivos)
const kernelObjectHandles = new Map();
let nextKernelObjectHandle = 0x4000;

// UNICODE_STRING do chamador: escreve `text` respeitando MaximumLength
function fillUnicodeString(unicodePointer, text, returnedLengthPointer) {
    const maximumLength = GuestMemory.readGuest16(unicodePointer + 2);
    const buffer = GuestMemory.readGuest64(unicodePointer + 8);
    const needed = text.length * 2;
    if (returnedLengthPointer)
        GuestMemory.writeGuest32(returnedLengthPointer, needed);
    if (needed > maximumLength) return 0xC0000023 | 0;   // STATUS_BUFFER_TOO_SMALL
    for (let i = 0; i < text.length; i++)
        GuestMemory.writeGuest16(buffer + i * 2, text.charCodeAt(i));
    GuestMemory.writeGuest16(unicodePointer, needed);
    return 0;
}

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
// Resolve no namespace: arquivo em FS montado (ramfs/NTFS) OU dispositivo
// (abertura real via IRP_MJ_CREATE, como o NT faz para \Device\X)
function zwCreateFile(outHandlePointer, _desiredAccess, objectAttributesPointer,
                      ioStatusPointer, _allocationSize, _fileAttributes,
                      _shareAccess, createDisposition, _createOptions,
                      _eaBuffer, _eaLength) {
    const objectName = keyPathFromObjectAttributes(objectAttributesPointer);

    // dispositivo: abre com CREATE IRP pelo I/O manager (caminho nativo)
    const deviceNode = ObjectManager.lookup(objectName);
    if (deviceNode && deviceNode.type === 'Device') {
        const opened = IoManager.openDevice(objectName);
        if (opened.status !== 0) {
            writeIoStatus(ioStatusPointer, 0xC0000034, 0);
            return 0xC0000034 | 0;
        }
        const handle = nextFileHandle++;
        fileHandles.set(handle, { devicePath: objectName,
                                  deviceHandle: opened.handle });
        GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
        GuestMemory.writeGuest32(outHandlePointer + 4, 0);
        writeIoStatus(ioStatusPointer, 0, FILE_OPENED);
        return 0;
    }

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

    // handle de DISPOSITIVO: READ IRP real com o FILE_OBJECT do handle
    if (entry.deviceHandle) {
        const ioRequest = IoManager.readHandle(entry.deviceHandle);
        if (ioRequest.status !== 0) return 0xC000000D | 0;
        const count = Math.min(length >>> 0, ioRequest.info);
        for (let i = 0; i < count; i++)
            GuestMemory.writeGuest8(bufferPointer + i,
                                    ioRequest.result.charCodeAt(i) & 0xFF);
        writeIoStatus(ioStatusPointer, 0, count);
        return 0;
    }

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

    // handle de DISPOSITIVO: WRITE IRP real
    if (entry.deviceHandle) {
        let data = '';
        for (let i = 0; i < (length >>> 0); i++)
            data += String.fromCharCode(GuestMemory.readGuest8(bufferPointer + i));
        const ioRequest = IoManager.writeHandle(entry.deviceHandle, data);
        if (ioRequest.status !== 0) return 0xC000000D | 0;
        writeIoStatus(ioStatusPointer, 0, ioRequest.info);
        return 0;
    }

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
        'ZwOpenFile',
        'ZwQueryInformationFile',
        'ZwSetInformationFile',
        'ZwLoadDriver',
        'ZwUnloadDriver',
        'ZwQuerySystemInformation',
        'ZwPowerInformation',
        'ZwWaitForSingleObject',           // (handle, alertable, timeoutPtr)
        'ZwOpenEvent',                     // (out, access, objAttr)
        'ZwCreateDirectoryObject',         // (out, access, objAttr)
        'ZwMakeTemporaryObject',           // (handle)
        'ZwOpenSymbolicLinkObject',        // (out, access, objAttr)
        'ZwQuerySymbolicLinkObject',       // (handle, outUni, outLen)
        'ZwFsControlFile',                 // (handle, ev, apc, ctx, iosb, code, in, inLen, out, outLen)
        'ZwQueryVolumeInformationFile',    // (handle, iosb, buf, len, class)
        'ZwQueryDirectoryFile',            // (handle, ev, apc, ctx, iosb, buf, len, class, single, name, restart)
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
        // dataSize e' o 6o arg (PILHA): o chamador so garante 32 bits — >>> 0
        (keyHandle, valueNamePointer, _titleIndex, valueType, dataPointer, dataSize) => {
            const dataLength = dataSize >>> 0;
            const dataStart = dataPointer >>> 0;
            const valueName = GuestStrings.readUnicodeString(valueNamePointer);
            const data = [];
            for (let i = 0; i < dataLength; i++)
                data.push(GuestMemory.readGuest8(dataStart + i));
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
        // OU de dispositivo (CLEANUP+CLOSE IRPs, como o NT)
        (anyHandle) => {
            const fileEntry = fileHandles.get(anyHandle >>> 0);
            if (fileEntry) {
                fileHandles.delete(anyHandle >>> 0);
                if (fileEntry.deviceHandle)
                    IoManager.closeDevice(fileEntry.deviceHandle);
                return 0;
            }
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
        // ZwOpenFile(outHandle, access, objAttrs, ioStatus, share, options):
        // abre arquivo existente (= ZwCreateFile com FILE_OPEN)
        (outHandlePointer, desiredAccess, objectAttributesPointer,
         ioStatusPointer, _shareAccess, _openOptions) =>
            zwCreateFile(outHandlePointer, desiredAccess, objectAttributesPointer,
                         ioStatusPointer, 0, 0, 0, FILE_OPEN, 0, 0, 0),
        // ZwQueryInformationFile(handle, ioStatus, out, length, infoClass)
        // FileStandardInformation(5): +0 AllocationSize u64, +8 EndOfFile u64,
        // +16 NumberOfLinks u32, +20 DeletePending u8, +21 Directory u8
        (fileHandle, ioStatusPointer, outBufferPointer, bufferLength,
         infoClass) => {
            const entry = fileHandles.get(fileHandle >>> 0);
            if (!entry) return STATUS_INVALID_HANDLE | 0;
            if ((infoClass >>> 0) !== 5) return 0xC000000D | 0;  // FileStandardInformation
            if (bufferLength < 0x18) return STATUS_BUFFER_TOO_SMALL | 0;
            const size = entry.fs.size ? entry.fs.size(entry.fsPath) : 0;
            GuestMemory.writeGuest64(outBufferPointer, size);        // AllocationSize
            GuestMemory.writeGuest64(outBufferPointer + 8, size);    // EndOfFile
            GuestMemory.writeGuest32(outBufferPointer + 16, 1);      // NumberOfLinks
            GuestMemory.writeGuest8(outBufferPointer + 20, 0);       // DeletePending
            GuestMemory.writeGuest8(outBufferPointer + 21, 0);       // Directory=FALSE
            writeIoStatus(ioStatusPointer, 0, 0x18);
            return 0;
        },
        // ZwSetInformationFile(handle, ioStatus, in, length, infoClass)
        // FileDispositionInformation(13/64): { DeleteFile u8 } — deleta de
        // verdade (ramfs); NTFS e' read-only -> MEDIA_WRITE_PROTECTED
        (fileHandle, ioStatusPointer, inputPointer, _bufferLength,
         infoClass) => {
            const entry = fileHandles.get(fileHandle >>> 0);
            if (!entry) return STATUS_INVALID_HANDLE | 0;
            const infoClassValue = infoClass >>> 0;
            if (infoClassValue !== 13 && infoClassValue !== 64)
                return 0xC000000D | 0;
            const shouldDelete = GuestMemory.readGuest8(inputPointer) !== 0;
            if (shouldDelete) {
                if (typeof entry.fs.remove !== 'function')
                    return STATUS_MEDIA_WRITE_PROTECTED | 0;
                entry.fs.remove(entry.fsPath);
            }
            writeIoStatus(ioStatusPointer, 0, 0);
            return 0;
        },
        // ZwLoadDriver(registryPathUniPtr): le o servico no Registry
        // (DriverFile) e carrega o .sys — o caminho real do Service Control
        (registryPathPointer) => {
            const registryPath = GuestStrings.readUnicodeString(registryPathPointer);
            const serviceName = registryPath.split('\\').pop();
            const entry = Registry.readValueByPath(
                '\\Registry\\Machine\\System\\Services\\' + serviceName,
                'DriverFile');
            if (!entry) return STATUS_OBJECT_NAME_NOT_FOUND | 0;
            let driverFile = '';
            for (const b of entry.data) { if (!b) break; driverFile += String.fromCharCode(b); }
            try {
                Lifecycle.loadDriver('/' + driverFile);
            } catch (loadError) {
                os.debugPrint('[zw] ZwLoadDriver falhou: ' + loadError.message);
                return 0xC0000034 | 0;
            }
            return 0;
        },
        // ZwUnloadDriver(registryPathUniPtr): descarrega o driver do servico
        (registryPathPointer) => {
            const registryPath = GuestStrings.readUnicodeString(registryPathPointer);
            const serviceName = registryPath.split('\\').pop();
            const entry = Registry.readValueByPath(
                '\\Registry\\Machine\\System\\Services\\' + serviceName,
                'DriverFile');
            if (!entry) return STATUS_OBJECT_NAME_NOT_FOUND | 0;
            let driverFile = '';
            for (const b of entry.data) { if (!b) break; driverFile += String.fromCharCode(b); }
            const driverName = driverFile.replace(/\.sys$/i, '');
            return Lifecycle.unloadDriver(driverName)
                ? 0 : 0xC0000034 | 0;
        },
        // ZwQuerySystemInformation(5=SystemProcessInformation, out, len, outLen)
        // Enumera a cadeia PsActiveProcessHead no formato real do NT.
        (infoClass, outBufferPointer, bufferLength, outLengthPointer) => {
            if ((infoClass >>> 0) !== 5) return 0xC000000D | 0;   // SystemProcessInformation
            const processes = Process.listActiveProcesses();
            const ENTRY_SIZE = 0x70;   // ate SessionId, layout documentado
            let cursor = outBufferPointer;
            let written = 0;
            for (let i = 0; i < processes.length; i++) {
                const processInfo = processes[i];
                const nameBytes = processInfo.name.length * 2;
                const stride = ENTRY_SIZE + nameBytes + 2;   // nome vai no fim
                if (cursor + stride > outBufferPointer + bufferLength) break;
                const isLast = i === processes.length - 1;
                GuestMemory.writeGuest32(cursor + 0x00,
                                         isLast ? 0 : stride);          // NextEntryOffset
                GuestMemory.writeGuest32(cursor + 0x04, 1);              // NumberOfThreads
                // ImageName: UNICODE_STRING { Length @0x38, Max @0x3A, Buffer @0x40 }
                GuestMemory.writeGuest16(cursor + 0x38, nameBytes);
                GuestMemory.writeGuest16(cursor + 0x3A, nameBytes + 2);
                GuestMemory.writeGuest64(cursor + 0x40,
                                         cursor + ENTRY_SIZE);           // Buffer
                GuestMemory.writeGuest64(cursor + 0x50,
                                         processInfo.pid);               // UniqueProcessId
                GuestMemory.writeGuest64(cursor + 0x58, 0);              // InheritedFrom
                GuestMemory.writeGuest32(cursor + 0x64, 0);              // SessionId
                for (let c = 0; c < processInfo.name.length; c++)
                    GuestMemory.writeGuest16(cursor + ENTRY_SIZE + c * 2,
                                             processInfo.name.charCodeAt(c));
                cursor += stride;
                written = cursor - outBufferPointer;
            }
            GuestMemory.writeGuest32(outLengthPointer, written);
            return 0;
        },
        // ZwPowerInformation(level, input, inLen, out, outLen):
        // level 4 = SystemPowerCapabilities (desktop: sem bateria, AC ligado)
        (informationLevel, _inputPointer, _inputLength, outBufferPointer,
         outputLength) => {
            if ((informationLevel >>> 0) !== 4) return 0xC000000D | 0;
            if (outputLength < 0x40) return STATUS_BUFFER_TOO_SMALL | 0;
            // SYSTEM_POWER_CAPABILITIES: presente, sem bateria, AC sempre ok
            GuestMemory.writeGuest8(outBufferPointer + 0x00, 1);   // PowerButton
            GuestMemory.writeGuest8(outBufferPointer + 0x01, 1);   // SleepButton
            GuestMemory.writeGuest8(outBufferPointer + 0x02, 0);   // LidSwitch
            GuestMemory.writeGuest8(outBufferPointer + 0x03, 1);   // S1 suportado
            GuestMemory.writeGuest8(outBufferPointer + 0x07, 1);   // AcOnLineWake
            GuestMemory.writeGuest8(outBufferPointer + 0x0C, 1);   // FastSystemS4?0
            return 0;
        },
        // ZwWaitForSingleObject(handle, alertable, timeoutPtr): espera real
        // no objeto do handle (eventos: KEVENT do convidado; o timeout e'
        // LARGE_INTEGER* — NULL infinito, 0 poll, negativo relativo)
        (handle, _alertable, timeoutPointer) => {
            const entry = kernelObjectHandles.get(handle >>> 0);
            if (!entry || entry.kind !== 'Event') return STATUS_INVALID_HANDLE | 0;
            return Dispatcher.waitForSingleObject(entry.dataPointer,
                                                  timeoutPointer) | 0;
        },
        // ZwOpenEvent(outHandle, access, objAttr): abre evento NOMEADO (ex:
        // \KernelObjects\HighMemoryCondition — semeados no phase0)
        (outHandlePointer, _accessMask, objectAttributesPointer) => {
            const objectName = keyPathFromObjectAttributes(objectAttributesPointer);
            const node = ObjectManager.lookup(objectName);
            if (!node || node.type !== 'Event')
                return STATUS_OBJECT_NAME_NOT_FOUND | 0;
            const handle = nextKernelObjectHandle++;
            kernelObjectHandles.set(handle, { kind: 'Event', node,
                                              dataPointer: node.data.eventPointer });
            GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
            GuestMemory.writeGuest32(outHandlePointer + 4, 0);
            return 0;
        },
        // ZwCreateDirectoryObject(outHandle, access, objAttr)
        (outHandlePointer, _accessMask, objectAttributesPointer) => {
            const objectName = keyPathFromObjectAttributes(objectAttributesPointer);
            const node = ObjectManager.createDirectory(objectName);
            if (!node) return 0xC0000035 | 0;   // STATUS_OBJECT_NAME_COLLISION
            const handle = nextKernelObjectHandle++;
            kernelObjectHandles.set(handle, { kind: 'Directory', node });
            GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
            GuestMemory.writeGuest32(outHandlePointer + 4, 0);
            return 0;
        },
        // ZwMakeTemporaryObject(handle): limpa o flag PERMANENT do objeto —
        // o NT o torna deletavel ao fechar o ultimo handle; nosso object
        // manager registra a marca (a coleta por refcount e' por handle)
        (handle) => {
            const entry = kernelObjectHandles.get(handle >>> 0);
            if (!entry || !entry.node) return STATUS_INVALID_HANDLE | 0;
            if (entry.node.data && typeof entry.node.data === 'object')
                entry.node.data.temporary = true;
            return 0;
        },
        // ZwOpenSymbolicLinkObject(outHandle, access, objAttr)
        (outHandlePointer, _accessMask, objectAttributesPointer) => {
            const objectName = keyPathFromObjectAttributes(objectAttributesPointer);
            const node = ObjectManager.lookup(objectName);
            if (!node || node.type !== 'SymbolicLink')
                return STATUS_OBJECT_NAME_NOT_FOUND | 0;
            const handle = nextKernelObjectHandle++;
            kernelObjectHandles.set(handle, { kind: 'SymbolicLink', node });
            GuestMemory.writeGuest32(outHandlePointer, handle >>> 0);
            GuestMemory.writeGuest32(outHandlePointer + 4, 0);
            return 0;
        },
        // ZwQuerySymbolicLinkObject(handle, outUniPtr, outLenPtr): o ALVO do
        // link (string) na UNICODE_STRING do chamador
        (handle, outUnicodePointer, returnedLengthPointer) => {
            const entry = kernelObjectHandles.get(handle >>> 0);
            if (!entry || entry.kind !== 'SymbolicLink')
                return STATUS_INVALID_HANDLE | 0;
            return fillUnicodeString(outUnicodePointer, entry.node.data,
                                     returnedLengthPointer) | 0;
        },
        // ZwFsControlFile(handle, event, apc, apcCtx, ioStatus, fsControlCode,
        //                 inBuf, inLen, outBuf, outLen): IRP_MJ_FILE_SYSTEM_
        // CONTROL para o device do handle (a uniao e' a do DEVICE_CONTROL)
        (fileHandle, _event, _apcRoutine, _apcContext, ioStatusPointer,
         fsControlCode, inputBuffer, inputLength, outputBuffer, outputLength) => {
            const entry = fileHandles.get(fileHandle >>> 0);
            if (!entry || !entry.deviceHandle)
                return STATUS_INVALID_HANDLE | 0;
            let data = '';
            for (let i = 0; i < (inputLength >>> 0); i++)
                data += String.fromCharCode(GuestMemory.readGuest8(inputBuffer + i));
            const ioRequest = IoManager.makeIoRequest(
                IoManager.IRP_MJ.FILE_SYSTEM_CONTROL, {
                    controlCode: fsControlCode, data,
                    bufferLength: outputLength >>> 0,
                });
            IoManager.callDriver(entry.devicePath, ioRequest);
            writeIoStatus(ioStatusPointer, ioRequest.status >>> 0,
                          ioRequest.info || 0);
            if (ioRequest.status === 0 && ioRequest.info > 0 && outputBuffer) {
                for (let i = 0; i < ioRequest.info; i++)
                    GuestMemory.writeGuest8(outputBuffer + i,
                                            ioRequest.result.charCodeAt(i) & 0xFF);
            }
            return ioRequest.status | 0;
        },
        // ZwQueryVolumeInformationFile(handle, ioStatus, buf, len, infoClass):
        // classes reais respondidas sobre o FS do handle (ramfs/NTFS)
        (fileHandle, ioStatusPointer, bufferPointer, length, infoClass) => {
            const entry = fileHandles.get(fileHandle >>> 0);
            if (!entry || !entry.fs) return STATUS_INVALID_HANDLE | 0;
            const fileList = entry.fs.list ? entry.fs.list() : [];
            const usedBytes = fileList.reduce(
                (total, filePath) => total +
                    Math.max(0, entry.fs.size ? entry.fs.size(filePath) : 0), 0);
            const written = (status, information) => {
                writeIoStatus(ioStatusPointer, status >>> 0, information);
                return status | 0;
            };
            if (infoClass === 1) {          // FileFsVolumeInformation
                const label = 'jsOS';
                GuestMemory.writeGuest64(bufferPointer, 0);
                GuestMemory.writeGuest32(bufferPointer + 8, 0x4A534F53);  // serial
                GuestMemory.writeGuest32(bufferPointer + 12, label.length * 2);
                GuestMemory.writeGuest8(bufferPointer + 16, 0);           // SupportsObjects
                for (let i = 0; i < label.length; i++)
                    GuestMemory.writeGuest16(bufferPointer + 18 + i * 2,
                                             label.charCodeAt(i));
                return written(0, 18 + label.length * 2);
            }
            if (infoClass === 3) {          // FileFsSizeInformation
                GuestMemory.writeGuest64(bufferPointer,
                                         Math.ceil(usedBytes / 512));
                GuestMemory.writeGuest64(bufferPointer + 8, 0);
                GuestMemory.writeGuest32(bufferPointer + 16, 1);    // setores/unit
                GuestMemory.writeGuest32(bufferPointer + 20, 512);  // bytes/setor
                return written(0, 24);
            }
            if (infoClass === 4) {          // FileFsDeviceInformation
                GuestMemory.writeGuest32(bufferPointer, 7);    // FILE_DEVICE_DISK
                GuestMemory.writeGuest32(bufferPointer + 4, 0);
                return written(0, 8);
            }
            if (infoClass === 5) {          // FileFsAttributeInformation
                const fsLabel = entry.fs.list ? 'RAMFS' : 'NTFS';
                GuestMemory.writeGuest32(bufferPointer, 0x00000002);  // CASE_SENSITIVE_SEARCH? nao: FILE_CASE_PRESERVED_NAMES
                GuestMemory.writeGuest32(bufferPointer + 4, 255);     // max component
                GuestMemory.writeGuest32(bufferPointer + 8, fsLabel.length * 2);
                for (let i = 0; i < fsLabel.length; i++)
                    GuestMemory.writeGuest16(bufferPointer + 12 + i * 2,
                                             fsLabel.charCodeAt(i));
                return written(0, 12 + fsLabel.length * 2);
            }
            return written(0xC000000D, 0);   // STATUS_INVALID_INFO_CLASS
        },
        // ZwQueryDirectoryFile(handle, event, apc, apcCtx, ioStatus, buf, len,
        // infoClass, returnSingleEntry, fileNamePtr, restartScan): listagem
        // FileDirectoryInformation(1) do diretorio aberto (estado por handle)
        (fileHandle, _event, _apcRoutine, _apcContext, ioStatusPointer,
         bufferPointer, length, infoClass, returnSingleEntry, fileNamePointer,
         restartScan) => {
            if ((infoClass >>> 0) !== 1) return 0xC000000D | 0;
            const entry = fileHandles.get(fileHandle >>> 0);
            if (!entry || !entry.fs || !entry.fs.list)
                return STATUS_INVALID_HANDLE | 0;
            if (restartScan || entry.directoryScanIndex === undefined)
                entry.directoryScanIndex = 0;
            const prefix = entry.fsPath === '/' ? '/' : entry.fsPath + '/';
            const names = entry.fs.list()
                .filter(filePath => filePath.startsWith(prefix) &&
                    !filePath.slice(prefix.length).includes('/'))
                .map(filePath => filePath.slice(prefix.length));
            const pattern = fileNamePointer
                ? GuestStrings.readUnicodeString(fileNamePointer) : null;
            const matched = (pattern && pattern !== '*')
                ? names.filter(name => name.toLowerCase() === pattern.toLowerCase())
                : names;
            let cursor = bufferPointer >>> 0;
            let previousRecordOffset = 0;
            let emitted = 0;
            while (entry.directoryScanIndex < matched.length) {
                const name = matched[entry.directoryScanIndex];
                const recordSize = 0x40 + name.length * 2;
                if ((cursor - bufferPointer) + recordSize > (length >>> 0)) break;
                const index = entry.directoryScanIndex;
                GuestMemory.writeGuest32(cursor + 0x04, index);          // FileIndex
                GuestMemory.writeGuest64(cursor + 0x28, entry.fs.size ?
                    Math.max(0, entry.fs.size(prefix + name)) : 0);      // EndOfFile
                GuestMemory.writeGuest64(cursor + 0x30, 0);              // AllocationSize
                GuestMemory.writeGuest32(cursor + 0x38, 0x80);           // FILE_ATTRIBUTE_NORMAL
                GuestMemory.writeGuest32(cursor + 0x3C, name.length * 2);
                for (let i = 0; i < name.length; i++)
                    GuestMemory.writeGuest16(cursor + 0x40 + i * 2,
                                             name.charCodeAt(i));
                if (previousRecordOffset)
                    GuestMemory.writeGuest32(previousRecordOffset,
                                             cursor - previousRecordOffset);
                previousRecordOffset = cursor;
                cursor += recordSize;
                entry.directoryScanIndex++;
                emitted++;
                if (returnSingleEntry) break;
            }
            if (previousRecordOffset)
                GuestMemory.writeGuest32(previousRecordOffset, 0);       // ultimo
            const information = cursor - bufferPointer;
            writeIoStatus(ioStatusPointer,
                          emitted ? 0 : 0x80000006,   // STATUS_NO_MORE_FILES
                          information);
            return emitted ? 0 : 0x80000006 | 0;
        },
    ],
    // compartilhado com o grupo io.js (IoCreateFile delega arquivos p/ ca)
    zwCreateFile,
    // helper JS (RtlCreateSystemVolumeInformationFolder): cria/abre arquivo
    // ou DIRETORIO por nome — caminho real do zwCreateFile, fechando ao fim
    createFileByName(objectName, createDisposition, createOptions,
                     fileAttributes) {
        const nameBuffer = GuestMemory.guestAllocBytes(objectName.length * 2 + 2);
        GuestStrings.writeGuestWideString(nameBuffer, objectName);
        const unicodePointer = GuestMemory.guestAllocBytes(16);
        GuestMemory.writeGuest16(unicodePointer, objectName.length * 2);
        GuestMemory.writeGuest16(unicodePointer + 2, objectName.length * 2 + 2);
        GuestMemory.writeGuest64(unicodePointer + 8, nameBuffer);
        const attributesPointer = GuestMemory.guestAllocBytes(
            NtAbi.OBJECT_ATTRIBUTES.SIZE);
        GuestMemory.writeGuest64(attributesPointer +
            NtAbi.OBJECT_ATTRIBUTES.OBJECT_NAME, unicodePointer);
        const ioStatusPointer = GuestMemory.guestAllocBytes(16);
        const outHandlePointer = GuestMemory.guestAllocBytes(8);
        const status = zwCreateFile(outHandlePointer, 0, attributesPointer,
                                    ioStatusPointer, 0, fileAttributes, 0,
                                    createDisposition, createOptions, 0, 0);
        if (status === 0) {
            const handle = GuestMemory.readGuest32(outHandlePointer);
            fileHandles.delete(handle >>> 0);   // fecha (como ZwClose)
        }
        return status | 0;
    },
};
