// ===========================================================================
// jsOS - system32/win32/ntoskrnl/ob.js: exports Ob* (Object Manager) com a
// contagem de referencia REAL do DEVICE_OBJECT (campo ReferenceCount @4) —
// e essa contagem que protege um driver de ser descarregado com handles
// abertos (ver lifecycle.js).
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const ObjectManager = require('ntos/ob/object-manager');

const DEVICE = NtAbi.DEVICE_OBJECT;

function readRefCount(devicePointer) {
    return GuestMemory.readGuest32(devicePointer + DEVICE.REFERENCE_COUNT) | 0;
}
function writeRefCount(devicePointer, value) {
    GuestMemory.writeGuest32(devicePointer + DEVICE.REFERENCE_COUNT, value >>> 0);
}

// resolve o ponteiro nativo de um objeto nomeado (Device ou Driver)
function nativePointerOfNode(node) {
    if (!node || !node.data) return 0;
    if (node.type === 'Device')
        return node.data.stackTopPointer || node.data.nativeDevicePointer;
    if (node.type === 'Driver') return node.data.driverObjectPointer || 0;
    return 0;
}

module.exports = {
    names: [
        'ObReferenceObject',          // (objectPtr) -> novo refcount
        'ObDereferenceObject',        // (objectPtr) -> novo refcount
        'ObfReferenceObject',         // fastcall idem
        'ObfDereferenceObject',
        'ObReferenceObjectByName',    // (namePtr, attrs, access, type, mode, ctx, outPtr)
        'ObOpenObjectByName',         // (objAttrs, type, mode, ctx, outHandle)
    ],
    handlers: [
        // ObReferenceObject(objectPtr) -> LONG novo
        (objectPointer) => {
            const value = readRefCount(objectPointer) + 1;
            writeRefCount(objectPointer, value);
            return value;
        },
        // ObDereferenceObject(objectPtr) -> LONG novo
        (objectPointer) => {
            const value = readRefCount(objectPointer) - 1;
            writeRefCount(objectPointer, value);
            return value;
        },
        // ObfReferenceObject: mesma semantica
        (objectPointer) => {
            const value = readRefCount(objectPointer) + 1;
            writeRefCount(objectPointer, value);
            return value;
        },
        // ObfDereferenceObject
        (objectPointer) => {
            const value = readRefCount(objectPointer) - 1;
            writeRefCount(objectPointer, value);
            return value;
        },
        // ObReferenceObjectByName(nameUniPtr, attrs, access, type, mode, ctx, outPtr)
        (namePointer, _attributes, _access, _objectType, _accessMode,
         _parseContext, outputPointer) => {
            const name = GuestStrings.readUnicodeString(namePointer);
            const node = ObjectManager.lookup(name);
            const pointer = nativePointerOfNode(node);
            if (!pointer) return 0xC0000034 | 0;   // OBJECT_NAME_NOT_FOUND
            writeRefCount(pointer, readRefCount(pointer) + 1);
            node.refs++;
            GuestMemory.writeGuest64(outputPointer, pointer);
            return 0;
        },
        // ObOpenObjectByName(objAttrs, type, mode, ctx, outHandlePtr):
        // devolve um handle do Object Manager para o objeto nomeado
        (objectAttributesPointer, _objectType, _accessMode, _parseContext,
         outHandlePointer) => {
            const namePointer = GuestMemory.readGuest32(objectAttributesPointer +
                                                        NtAbi.OBJECT_ATTRIBUTES.OBJECT_NAME);
            const name = GuestStrings.readUnicodeString(namePointer);
            const node = ObjectManager.lookup(name);
            const pointer = nativePointerOfNode(node);
            if (!pointer) return 0xC0000034 | 0;
            writeRefCount(pointer, readRefCount(pointer) + 1);
            const handle = ObjectManager.open(name);
            GuestMemory.writeGuest64(outHandlePointer, handle);
            return 0;
        },
    ],
};
