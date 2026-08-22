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
const PowerManager = require('ntos/po/power-manager');

const DEVICE = NtAbi.DEVICE_OBJECT;

// cria um DEVICE_OBJECT real no namespace + encadeado na lista do driver.
// A DeviceExtension (se pedida) fica logo apos o DEVICE_OBJECT, como o NT faz.
function createDevice(driverObjectPointer, extensionSize, deviceName, deviceType,
                      characteristics, outputPointer) {
    const shortName = deviceName ? deviceName.replace(/^\\Device\\/i, '') : 'Unnamed';
    const devicePage = GuestMemory.guestAllocBytes(DEVICE.STRUCT_SIZE + extensionSize);

    GuestMemory.writeGuest16(devicePage + DEVICE.TYPE, DEVICE.IO_TYPE);
    GuestMemory.writeGuest16(devicePage + DEVICE.SIZE, DEVICE.STRUCT_SIZE);
    GuestMemory.writeGuest32(devicePage + DEVICE.REFERENCE_COUNT, 1);
    GuestMemory.writeGuest64(devicePage + DEVICE.DRIVER_OBJECT, driverObjectPointer);
    GuestMemory.writeGuest32(devicePage + DEVICE.DEVICE_TYPE, deviceType >>> 0);
    GuestMemory.writeGuest32(devicePage + DEVICE.CHARACTERISTICS, characteristics >>> 0);
    GuestMemory.writeGuest8(devicePage + DEVICE.STACK_SIZE, 1);
    GuestMemory.writeGuest64(devicePage + DEVICE.DEVICE_EXTENSION,
                             extensionSize ? devicePage + DEVICE.STRUCT_SIZE : 0);

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
    PowerManager.forgetDevice(devicePointer);
    require('ntos/io/io-timer').forgetDevice(devicePointer);
    return 0;
}

// IoAttachDeviceToDeviceStack(source, target) -> device sobre o qual anexou.
// Sobe o source ao TOPO da pilha do alvo (cadeia AttachedDevice), ajusta o
// StackSize (+1) e faz o namespace despachar IRPs do alvo p/ o novo topo.
function attachDeviceToDeviceStack(sourcePointer, targetPointer) {
    let topPointer = targetPointer;
    for (;;) {
        const next = GuestMemory.readGuest32(topPointer + DEVICE.ATTACHED_DEVICE);
        if (!next) break;
        topPointer = next;
    }
    GuestMemory.writeGuest64(topPointer + DEVICE.ATTACHED_DEVICE, sourcePointer);
    const targetStackSize = GuestMemory.readGuest8(topPointer + DEVICE.STACK_SIZE) || 1;
    GuestMemory.writeGuest8(sourcePointer + DEVICE.STACK_SIZE, targetStackSize + 1);

    const driverRoot = ObjectManager.lookup('\\Device');
    if (driverRoot && driverRoot.children) {
        for (const child of driverRoot.children.values()) {
            if (child.data && child.data.nativeDevicePointer === targetPointer) {
                child.data.stackTopPointer = sourcePointer;
                break;
            }
        }
    }
    return topPointer;
}

// IoDetachDevice(target): desanexa o device imediatamente ACIMA do alvo
function detachDevice(targetPointer) {
    const upperPointer = GuestMemory.readGuest32(targetPointer + DEVICE.ATTACHED_DEVICE);
    if (!upperPointer) return 0;
    GuestMemory.writeGuest64(targetPointer + DEVICE.ATTACHED_DEVICE,
        GuestMemory.readGuest64(upperPointer + DEVICE.ATTACHED_DEVICE));
    GuestMemory.writeGuest64(upperPointer + DEVICE.ATTACHED_DEVICE, 0);

    const driverRoot = ObjectManager.lookup('\\Device');
    if (driverRoot && driverRoot.children) {
        for (const child of driverRoot.children.values()) {
            if (child.data && child.data.stackTopPointer === upperPointer) {
                child.data.stackTopPointer = targetPointer;
                break;
            }
        }
    }
    return 0;
}

// IoGetDeviceObjectPointer(name, access, outFileObject, outDeviceObject)
// Resolve o nome no namespace; devolve o TOPO da pilha + um FILE_OBJECT real.
function getDeviceObjectPointer(namePointer, _access, fileObjectOut, deviceObjectOut) {
    const name = GuestStrings.readUnicodeString(namePointer);
    const node = ObjectManager.lookup(name);
    if (!node || node.type !== 'Device')
        return 0xC0000034 | 0;   // STATUS_OBJECT_NAME_NOT_FOUND
    const devicePointer = node.data.stackTopPointer || node.data.nativeDevicePointer;
    const fileObjectPointer = GuestMemory.guestAllocBytes(NtAbi.FILE_OBJECT.STRUCT_SIZE);
    GuestMemory.writeGuest16(fileObjectPointer + NtAbi.FILE_OBJECT.TYPE, 5);
    GuestMemory.writeGuest16(fileObjectPointer + NtAbi.FILE_OBJECT.SIZE,
                             NtAbi.FILE_OBJECT.STRUCT_SIZE);
    GuestMemory.writeGuest64(fileObjectPointer + NtAbi.FILE_OBJECT.DEVICE_OBJECT,
                             devicePointer);
    GuestMemory.writeGuest64(fileObjectOut, fileObjectPointer);
    GuestMemory.writeGuest64(deviceObjectOut, devicePointer);
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
        'IoCallDriver',
        'IofCallDriver',              // nome real exportado (IoCallDriver e macro)
        'IoAttachDeviceToDeviceStack',
        'IoDetachDevice',
        'IoGetDeviceObjectPointer',
        'IoBuildSynchronousFsdRequest',   // (major, dev, buf, len, offPtr, event, iosb)
        'IoBuildDeviceIoControlRequest',  // (code, dev, in, inLen, out, outLen, internal, event, iosb)
        'IoInitializeTimer',              // (dev, routinePtr, contextPtr)
        'IoStartTimer',
        'IoStopTimer',
        'IoQueueWorkItemEx',              // (item, routineExPtr, queueType, contextPtr)
    ],
    handlers: [
        // IoCreateDevice(drvObj, extSize, nameUniPtr, type, chars, exclusive, outPtr)
        (driverObjectPointer, extensionSize, namePointer, deviceType,
         characteristics, _exclusive, outputPointer) =>
            createDevice(driverObjectPointer, extensionSize >>> 0,
                         namePointer ? GuestStrings.readUnicodeString(namePointer) : null,
                         deviceType >>> 0, characteristics >>> 0, outputPointer),
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
        // IoAllocateIrp(stackSize, chargeQuota) -> IRP real zerado, posicionado
        // ACIMA do topo da pilha (convencao NT: o 1o IofCallDriver desce)
        (stackSize, _chargeQuota) => {
            const count = Math.max(1, stackSize);
            const size = NtAbi.IRP.STRUCT_SIZE + count * NtAbi.IRP.STACK_LOCATION_SIZE;
            const address = GuestMemory.guestAllocBytes(size);
            GuestMemory.writeGuest16(address + NtAbi.IRP.TYPE, NtAbi.IRP.IO_TYPE);
            GuestMemory.writeGuest16(address + NtAbi.IRP.SIZE_FIELD, size);
            GuestMemory.writeGuest8(address + NtAbi.IRP.STACK_COUNT, count);
            GuestMemory.writeGuest8(address + NtAbi.IRP.CURRENT_LOCATION, count + 1);
            GuestMemory.writeGuest64(address + NtAbi.IRP.CURRENT_STACK_LOCATION,
                                     address + NtAbi.IRP.STRUCT_SIZE +
                                     count * NtAbi.IRP.STACK_LOCATION_SIZE);
            return address;
        },
        // IoFreeIrp(irpPtr)
        (ioRequestPointer) => { GuestMemory.guestFreeBytes(ioRequestPointer); return 0; },
        // IoCompleteRequest(irpPtr, priorityBoost): conclusao real — sobe a
        // pilha chamando as completion routines (ver ntos/io/io-manager.js)
        (ioRequestPointer, _priorityBoost) =>
            require('ntos/io/io-manager').iofCompleteRequest(ioRequestPointer),
        // IofCompleteRequest: idem (IoCompleteRequest e macro p/ ela)
        (ioRequestPointer, _priorityBoost) =>
            require('ntos/io/io-manager').iofCompleteRequest(ioRequestPointer),
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
        // IoCallDriver(devicePtr, irpPtr) / IofCallDriver: desce um nivel
        (devicePointer, ioRequestPointer) =>
            require('ntos/io/io-manager').iofCallDriver(devicePointer,
                                                        ioRequestPointer),
        (devicePointer, ioRequestPointer) =>
            require('ntos/io/io-manager').iofCallDriver(devicePointer,
                                                        ioRequestPointer),
        // IoAttachDeviceToDeviceStack(sourcePtr, targetPtr) -> topo anterior
        (sourcePointer, targetPointer) =>
            attachDeviceToDeviceStack(sourcePointer, targetPointer),
        // IoDetachDevice(targetPtr)
        (targetPointer) => detachDevice(targetPointer),
        // IoGetDeviceObjectPointer(namePtr, access, outFileObj, outDevObj)
        (namePointer, access, fileObjectOut, deviceObjectOut) =>
            getDeviceObjectPointer(namePointer, access, fileObjectOut,
                                   deviceObjectOut),
        // IoBuildSynchronousFsdRequest(major, devPtr, bufPtr, len, offPtr,
        //                              eventPtr, iosbPtr) -> IRP
        (major, devicePointer, bufferPointer, length, byteOffsetPointer,
         eventPointer, ioStatusPointer) =>
            require('ntos/io/io-manager').buildSynchronousFsdRequest(
                major, devicePointer, bufferPointer, length, byteOffsetPointer,
                eventPointer, ioStatusPointer),
        // IoBuildDeviceIoControlRequest(code, devPtr, inPtr, inLen, outPtr,
        //                               outLen, internal, eventPtr, iosbPtr)
        (ioctlCode, devicePointer, inputBuffer, inputLength, outputBuffer,
         outputLength, internal, eventPointer, ioStatusPointer) =>
            require('ntos/io/io-manager').buildDeviceIoControlRequest(
                ioctlCode, devicePointer, inputBuffer, inputLength,
                outputBuffer, outputLength, internal, eventPointer,
                ioStatusPointer),
        // IoInitializeTimer(devPtr, routinePtr, contextPtr)
        (devicePointer, routinePointer, contextPointer) =>
            require('ntos/io/io-timer').initializeTimer(devicePointer,
                routinePointer, contextPointer),
        // IoStartTimer(devPtr)
        (devicePointer) =>
            require('ntos/io/io-timer').startTimer(devicePointer),
        // IoStopTimer(devPtr)
        (devicePointer) =>
            require('ntos/io/io-timer').stopTimer(devicePointer),
        // IoQueueWorkItemEx(itemPtr, routineExPtr, queueType, contextPtr):
        // a routine recebe (ioObject, context, ioWorkItem) — 3 args
        (itemPointer, routinePointer, queueType, contextPointer) => {
            WorkItems.queueWorkItemEx(itemPointer, routinePointer, queueType,
                                      contextPointer, true);
            return 0;
        },
    ],
};
