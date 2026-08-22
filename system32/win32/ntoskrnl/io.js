// ===========================================================================
// jsOS - system32/win32/ntoskrnl/io.js: exports Io* (estilo NT, ABI real do
// WDK via win32/nt-abi.js). Devices vivem no namespace do Object Manager e
// encadeados na lista do driver (DeviceObject->NextDevice), como no NT.
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');
const ObjectManager = require('ntos/ob/object-manager');
const WorkItems = require('ntos/io/work-items');
const Lifecycle = require('win32/ntoskrnl/lifecycle');

const DEVICE = NtAbi.DEVICE_OBJECT;

// cria um DEVICE_OBJECT real no namespace + encadeado na lista do driver
function createDevice(driverObjectPointer, deviceName, outputPointer) {
    const shortName = deviceName ? deviceName.replace(/^\\Device\\/i, '') : 'Unnamed';
    const devicePage = GuestMemory.guestAllocBytes(DEVICE.STRUCT_SIZE);

    GuestMemory.writeGuest16(devicePage + DEVICE.TYPE, DEVICE.IO_TYPE);
    GuestMemory.writeGuest16(devicePage + DEVICE.SIZE, DEVICE.STRUCT_SIZE);
    GuestMemory.writeGuest32(devicePage + DEVICE.REFERENCE_COUNT, 1);
    GuestMemory.writeGuest64(devicePage + DEVICE.DRIVER_OBJECT, driverObjectPointer);

    // encadeia na cabeca da lista de devices do driver (como o NT)
    const previousHead = GuestMemory.readGuest32(driverObjectPointer + NtAbi.DRIVER_OBJECT.DEVICE_OBJECT);
    GuestMemory.writeGuest64(devicePage + DEVICE.NEXT_DEVICE, previousHead);
    GuestMemory.writeGuest32(driverObjectPointer + NtAbi.DRIVER_OBJECT.DEVICE_OBJECT,
                             devicePage >>> 0);

    // registra no namespace ligado ao driver atual
    const driverNode = Lifecycle.getCurrentDriverNode();
    if (driverNode) {
        const deviceNode = ObjectManager.createObject('\\Device', shortName, 'Device',
                                                      { driver: driverNode });
        deviceNode.data.nativeDevicePointer = devicePage;
        driverNode.data.devices.push(deviceNode);
    }

    GuestMemory.writeGuest32(outputPointer, devicePage >>> 0);
    GuestMemory.writeGuest32(outputPointer + 4, 0);
    return 0;   // STATUS_SUCCESS
}

function deleteDevice(devicePointer) {
    const driverObjectPointer = GuestMemory.readGuest32(devicePointer + DEVICE.DRIVER_OBJECT);
    // desencadeia da lista do driver
    let previousPointer = driverObjectPointer + NtAbi.DRIVER_OBJECT.DEVICE_OBJECT;
    for (;;) {
        const current = GuestMemory.readGuest32(previousPointer);
        if (!current) break;
        if (current === devicePointer) {
            GuestMemory.writeGuest32(previousPointer,
                                     GuestMemory.readGuest32(devicePointer + DEVICE.NEXT_DEVICE));
            break;
        }
        previousPointer = current + DEVICE.NEXT_DEVICE;
    }
    // remove do namespace
    const driverRoot = ObjectManager.lookup('\\Device');
    if (driverRoot && driverRoot.children) {
        for (const child of [...driverRoot.children.values()]) {
            if (child.data && child.data.nativeDevicePointer === devicePointer) {
                ObjectManager.unlink('\\Device\\' + child.name);
                break;
            }
        }
    }
    GuestMemory.guestFreeBytes(devicePointer);
    return 0;
}

module.exports = {
    names: [
        'IoCreateDevice',
        'IoCreateSymbolicLink',
        'IoDeleteDevice',
        'IoDeleteSymbolicLink',
        'IoAllocateIrp',
        'IoFreeIrp',
        'IoCompleteRequest',
        'IofCompleteRequest',
        'IoAllocateWorkItem',
        'IoQueueWorkItem',
        'IoFreeWorkItem',
    ],
    handlers: [
        // IoCreateDevice(drvObj, extSize, nameUniPtr, type, chars, exclusive, outPtr)
        (driverObjectPointer, _extensionSize, namePointer, _deviceType,
         _characteristics, _exclusive, outputPointer) =>
            createDevice(driverObjectPointer,
                         namePointer ? GuestStrings.readUnicodeString(namePointer) : null,
                         outputPointer),
        // IoCreateSymbolicLink(linkUniPtr, targetUniPtr)
        (linkPointer, targetPointer) => {
            ObjectManager.createSymlink(GuestStrings.readUnicodeString(linkPointer),
                                        GuestStrings.readUnicodeString(targetPointer));
            return 0;
        },
        // IoDeleteDevice(devicePtr)
        (devicePointer) => deleteDevice(devicePointer),
        // IoDeleteSymbolicLink(linkUniPtr)
        (linkPointer) =>
            ObjectManager.unlink(GuestStrings.readUnicodeString(linkPointer))
                ? 0 : 0xC0000009,   // STATUS_NOT_FOUND
        // IoAllocateIrp(stackSize, chargeQuota) -> IRP real zerado
        (stackSize, _chargeQuota) => {
            const size = NtAbi.IRP.STRUCT_SIZE +
                         Math.max(1, stackSize) * NtAbi.IRP.STACK_LOCATION_SIZE;
            const address = GuestMemory.guestAllocBytes(size);
            GuestMemory.writeGuest16(address + NtAbi.IRP.TYPE, NtAbi.IRP.IO_TYPE);
            GuestMemory.writeGuest16(address + NtAbi.IRP.SIZE_FIELD, size);
            GuestMemory.writeGuest8(address + NtAbi.IRP.STACK_COUNT, stackSize);
            GuestMemory.writeGuest8(address + NtAbi.IRP.CURRENT_LOCATION, 1);
            GuestMemory.writeGuest64(address + NtAbi.IRP.CURRENT_STACK_LOCATION,
                                     address + NtAbi.IRP.STRUCT_SIZE +
                                     (Math.max(1, stackSize) - 1) * NtAbi.IRP.STACK_LOCATION_SIZE);
            return address;
        },
        // IoFreeIrp(irpPtr)
        (ioRequestPointer) => { GuestMemory.guestFreeBytes(ioRequestPointer); return 0; },
        // IoCompleteRequest(irpPtr, priorityBoost): status ja esta no IoStatus;
        //   aqui so registramos a conclusao (toy: sem APC de user)
        (_ioRequestPointer, _priorityBoost) => 0,
        // IofCompleteRequest: mesma coisa (IoCompleteRequest e macro p/ ela)
        (_ioRequestPointer, _priorityBoost) => 0,
        // IoAllocateWorkItem(devicePtr) -> itemPointer
        (devicePointer) => {
            const itemPointer = GuestMemory.guestAllocBytes(NtAbi.IO_WORKITEM.SIZE);
            WorkItems.createWorkItem(devicePointer, itemPointer);
            return itemPointer;
        },
        // IoQueueWorkItem(itemPtr, routinePtr, queueType, contextPtr)
        (itemPointer, routinePointer, queueType, contextPointer) => {
            WorkItems.queueWorkItem(itemPointer, routinePointer, queueType, contextPointer);
            return 0;
        },
        // IoFreeWorkItem(itemPtr)
        (itemPointer) => {
            WorkItems.unqueue(itemPointer);
            GuestMemory.guestFreeBytes(itemPointer);
            return 0;
        },
    ],
};
