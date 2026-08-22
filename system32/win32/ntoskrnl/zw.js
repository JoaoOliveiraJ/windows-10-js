// ===========================================================================
// jsOS - system32/win32/ntoskrnl/zw.js: exports Zw* (Registry) com os
// layouts reais do NT (OBJECT_ATTRIBUTES @ win32/nt-abi.js,
// KEY_VALUE_PARTIAL_INFORMATION idem). Configuration Manager: ntos/cm/.
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const Registry = require('ntos/cm/registry');

const STATUS_NOT_FOUND = 0xC0000009;
const STATUS_BUFFER_TOO_SMALL = 0xC0000023;
const STATUS_INVALID_HANDLE = 0xC0000008;

function keyPathFromObjectAttributes(objectAttributesPointer) {
    const namePointer = GuestMemory.readGuest32(objectAttributesPointer +
                                                NtAbi.OBJECT_ATTRIBUTES.OBJECT_NAME);
    return GuestStrings.readUnicodeString(namePointer);
}

module.exports = {
    names: [
        'ZwCreateKey',
        'ZwOpenKey',
        'ZwSetValueKey',
        'ZwQueryValueKey',
        'ZwClose',
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
        // ZwClose(handle)
        (keyHandle) => Registry.closeHandle(keyHandle) ? 0 : STATUS_INVALID_HANDLE,
    ],
};
