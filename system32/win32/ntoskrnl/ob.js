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

// caminho inverso: acha o path completo de um objeto pelo ponteiro nativo
// (varre \Device, \Driver e \KernelObjects — os donos de objetos nomeados
// com corpo nativo no jsOS)
function findPathByNativePointer(nativePointer) {
    for (const rootPath of ['\\Device', '\\Driver', '\\KernelObjects']) {
        const rootNode = ObjectManager.lookup(rootPath);
        if (!rootNode || !rootNode.children) continue;
        for (const child of rootNode.children.values()) {
            if (!child.data) continue;
            if (nativePointerOfNode(child) === nativePointer)
                return rootPath + '\\' + child.name;
            if (child.type === 'Event' &&
                child.data.eventPointer === nativePointer)
                return rootPath + '\\' + child.name;
        }
    }
    return null;
}

module.exports = {
    names: [
        'ObReferenceObject',          // (objectPtr) -> novo refcount
        'ObDereferenceObject',        // (objectPtr) -> novo refcount
        'ObfReferenceObject',         // fastcall idem
        'ObfDereferenceObject',
        'ObReferenceObjectByName',    // (namePtr, attrs, access, type, mode, ctx, outPtr)
        'ObOpenObjectByName',         // (objAttrs, type, mode, ctx, outHandle)
        'ObReferenceObjectByHandle',  // (handle, access, type, mode, outPtr, info)
        'ObReferenceObjectByPointer', // (objectPtr, access, type, mode)
        'ObQueryNameString',          // (objectPtr, outUni, size, outLen)
        'ObIsDosDeviceLocallyMapped', // (index) -> BOOLEAN
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
        // ObReferenceObjectByHandle(handle, access, type, mode, outPtr, info):
        // valida o handle na tabela e devolve o objeto referenciado
        (handle, _access, _objectType, _accessMode, outputPointer,
         _handleInformation) => {
            const node = ObjectManager.getObject(handle >>> 0);
            let pointer = nativePointerOfNode(node);
            // eventos nomeados: o corpo do objeto e' o KEVENT do convidado
            if (!pointer && node && node.type === 'Event' && node.data)
                pointer = node.data.eventPointer || 0;
            if (!pointer) return 0xC0000008 | 0;   // STATUS_INVALID_HANDLE
            writeRefCount(pointer, readRefCount(pointer) + 1);
            node.refs++;
            GuestMemory.writeGuest64(outputPointer, pointer);
            return 0;
        },
        // ObReferenceObjectByPointer(objectPtr, access, type, mode)
        (objectPointer, _access, _objectType, _accessMode) => {
            if (!objectPointer) return 0xC000000D | 0;
            writeRefCount(objectPointer, readRefCount(objectPointer) + 1);
            return 0;
        },
        // ObQueryNameString(objectPtr, outUniPtr, bufferSize, outLenPtr): o
        // path completo do objeto (o NT devolve \Device\Harddisk0 etc.)
        (objectPointer, outUnicodePointer, bufferSize, returnLengthPointer) => {
            const fullPath = findPathByNativePointer(objectPointer >>> 0);
            if (!fullPath) {
                if (returnLengthPointer)
                    GuestMemory.writeGuest32(returnLengthPointer, 0);
                return 0xC000000D | 0;   // objeto sem nome: STATUS_INVALID_PARAMETER
            }
            const needed = fullPath.length * 2 + 2;
            if (returnLengthPointer)
                GuestMemory.writeGuest32(returnLengthPointer, needed);
            if ((bufferSize >>> 0) < needed)
                return 0xC0000004 | 0;   // STATUS_INFO_LENGTH_MISMATCH
            const buffer = GuestMemory.readGuest64(outUnicodePointer + 8);
            GuestStrings.writeGuestWideString(buffer, fullPath);
            GuestMemory.writeGuest16(outUnicodePointer, fullPath.length * 2);
            GuestMemory.writeGuest16(outUnicodePointer + 2,
                                     fullPath.length * 2 + 2);
            return 0;
        },
        // ObIsDosDeviceLocallyMapped(index) -> 0: nao temos device maps por
        // LUID (sem sessoes interativas/logon — resposta real do sistema)
        (_index) => 0,
    ],
};
