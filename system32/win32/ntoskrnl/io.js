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
const IoManager = require('ntos/io/io-manager');
const IoTimer = require('ntos/io/io-timer');
const KernelThreads = require('ntos/ps/kernel-threads');
const Process = require('ntos/ps/process');
const Zw = require('win32/ntoskrnl/zw');
const PciBus = require('drivers/bus/pci');
const Registry = require('ntos/cm/registry');
const Dispatcher = require('ntos/ke/dispatcher');
const Irql = require('ntos/ke/irql');
const InterruptObject = require('ntos/ke/interrupt-object');
const Controller = require('ntos/io/controller');
const StartIo = require('ntos/io/start-io');
const HwDescription = require('ntos/cm/hw-description');

const DEVICE = NtAbi.DEVICE_OBJECT;

// extensoes de driver object (IoAllocate/GetDriverObjectExtension):
// chave "driverObject:tag" -> bloco de dados do driver
const driverExtensions = new Map();

// mapa FDO -> PDO registrado no attach (para IoGetDeviceProperty achar o
// PDO de hardware de qualquer ponto da pilha)
const pdoOfAttachedDevice = new Map();

// devices com estado invalidado via IoInvalidateDeviceState (sinalizacao
// PnP real — o NT agenda um QUERY_DEVICE_STATE nesse ponto)
const invalidatedDevices = new Set();

// spinlock global de cancelamento (IoAcquire/ReleaseCancelSpinLock)
let cancelSpinLockPointer = 0;

// device interfaces: symlink -> { enabled, deviceName, notificationFired }
const deviceInterfaces = new Map();

// PnP notification registrations (IoRegisterPlugPlayNotification)
const plugPlayRegistrations = [];

// devices com classes WMI registradas (IoWMIRegistrationControl)
const wmiRegisteredDevices = new Set();

// acha o no \Device\<name> dono de um device pointer (para resolver o nome
// do PDO em IoGetDeviceProperty/PhysicalDeviceObjectName)
function findDeviceNodeByPointer(devicePointer) {
    const deviceRoot = ObjectManager.lookup('\\Device');
    if (!deviceRoot || !deviceRoot.children) return null;
    for (const child of deviceRoot.children.values()) {
        if (child.data && child.data.nativeDevicePointer === (devicePointer >>> 0))
            return child;
    }
    return null;
}

// IO_REMOVE_LOCK offsets (wdm.h, bloco comum): Removed @0, IoCount @4,
// WaitEvent (KEVENT) @0x10
const REMOVE_LOCK = { REMOVED: 0, IO_COUNT: 4, WAIT_EVENT: 0x10 };

// cria um DEVICE_OBJECT real no namespace + encadeado na lista do driver.
// A DeviceExtension (se pedida) fica logo apos o DEVICE_OBJECT, como o NT faz.
// devices sem nome (IoCreateDevice com DeviceName NULL): no NT o objeto
// simplesmente nao entra no namespace — aqui recebem um nome interno unico
let unnamedDeviceCounter = 0;

function createDevice(driverObjectPointer, extensionSize, deviceName, deviceType,
                      characteristics, outputPointer) {
    const shortName = deviceName ? deviceName.replace(/^\\Device\\/i, '')
                                 : 'Unnamed' + (unnamedDeviceCounter++);
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

    // registra no namespace ligado ao driver DONO do objeto (o NT liga o
    // device ao DRIVER_OBJECT do argumento — suporta carga aninhada de
    // drivers, ex: ZwLoadDriver dentro de um DriverEntry)
    const driverNode = Lifecycle.nodeByDriverObjectPointer(driverObjectPointer) ||
                       Lifecycle.getCurrentDriverNode();
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
    IoTimer.forgetDevice(devicePointer);
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
    pdoOfAttachedDevice.set(sourcePointer >>> 0, targetPointer >>> 0);

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
        'IoAllocateMdl',                  // (va, length, secondary, chargeQuota, irpPtr)
        'IoFreeMdl',
        'IoGetCurrentThread',
        'IoSetCancelRoutine',             // (irpPtr, routinePtr) -> anterior
        'IoCancelIrp',                    // (irpPtr) — cancela de verdade
        'IoAllocateDriverObjectExtension',   // (drvObj, tag, size, outPtr)
        'IoGetDriverObjectExtension',        // (drvObj, tag) -> extPtr
        'IoGetCurrentProcess',               // () -> thread corrente -> ApcState.Process
        'IoCreateFile',                      // 14 args (abertura completa por nome)
        'IoGetRelatedDeviceObject',          // (fileObjectPtr) -> topo da pilha
        'IoGetDeviceProperty',               // (dev, prop, bufLen, outBuf, outLen)
        'IoGetStackLimits',                  // (outLowPtr, outHighPtr) pilha real
        'IoInitializeRemoveLockEx',
        'IoAcquireRemoveLockEx',
        'IoReleaseRemoveLockEx',
        'IoReleaseRemoveLockAndWaitEx',
        'IoAllocateErrorLogEntry',
        'IoWriteErrorLogEntry',
        'IoAcquireCancelSpinLock',
        'IoReleaseCancelSpinLock',
        'IoRegisterDeviceInterface',
        'IoSetDeviceInterfaceState',
        'IoRegisterPlugPlayNotification',
        'IoUnregisterPlugPlayNotification',
        'IoRegisterDriverReinitialization',
        'IoOpenDeviceRegistryKey',
        'IoWMIRegistrationControl',
        'IoConnectInterrupt',              // KINTERRUPT + ISR nativa no vetor
        'IoDisconnectInterrupt',
        'IoCreateController',              // CONTROLLER_OBJECT (serializacao)
        'IoDeleteController',
        'IoAllocateController',
        'IoFreeController',
        'IoStartPacket',                   // modelo StartIo (fila por device)
        'IoStartNextPacket',
        'IoSetStartIoAttributes',
        'IoGetAttachedDeviceReference',    // topo da cadeia + referencia
        'IoInvalidateDeviceState',         // PnP: re-avaliar o estado do device
        'IoQueryDeviceDescription',        // legado: \Hardware\Description
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
            IoManager.iofCompleteRequest(ioRequestPointer),
        // IofCompleteRequest: idem (IoCompleteRequest e macro p/ ela)
        (ioRequestPointer, _priorityBoost) =>
            IoManager.iofCompleteRequest(ioRequestPointer),
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
            IoManager.iofCallDriver(devicePointer,
                                                        ioRequestPointer),
        (devicePointer, ioRequestPointer) =>
            IoManager.iofCallDriver(devicePointer,
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
            IoManager.buildSynchronousFsdRequest(
                major, devicePointer, bufferPointer, length, byteOffsetPointer,
                eventPointer, ioStatusPointer),
        // IoBuildDeviceIoControlRequest(code, devPtr, inPtr, inLen, outPtr,
        //                               outLen, internal, eventPtr, iosbPtr)
        (ioctlCode, devicePointer, inputBuffer, inputLength, outputBuffer,
         outputLength, internal, eventPointer, ioStatusPointer) =>
            IoManager.buildDeviceIoControlRequest(
                ioctlCode, devicePointer, inputBuffer, inputLength,
                outputBuffer, outputLength, internal, eventPointer,
                ioStatusPointer),
        // IoInitializeTimer(devPtr, routinePtr, contextPtr)
        (devicePointer, routinePointer, contextPointer) =>
            IoTimer.initializeTimer(devicePointer,
                routinePointer, contextPointer),
        // IoStartTimer(devPtr)
        (devicePointer) =>
            IoTimer.startTimer(devicePointer),
        // IoStopTimer(devPtr)
        (devicePointer) =>
            IoTimer.stopTimer(devicePointer),
        // IoQueueWorkItemEx(itemPtr, routineExPtr, queueType, contextPtr):
        // a routine recebe (ioObject, context, ioWorkItem) — 3 args
        (itemPointer, routinePointer, queueType, contextPointer) => {
            WorkItems.queueWorkItemEx(itemPointer, routinePointer, queueType,
                                      contextPointer, true);
            return 0;
        },
        // IoAllocateMdl(va, length, secondary, chargeQuota, irpPtr) -> MDL:
        // struct real do wdm.h + array de PFNs calculado pelas page tables
        (virtualAddress, length, _secondary, _chargeQuota, _irpPointer) => {
            const MDL = NtAbi.MDL;
            const startVa = virtualAddress & ~0xFFF;
            const byteOffset = virtualAddress & 0xFFF;
            const pageCount = Math.ceil((byteOffset + (length >>> 0)) / 0x1000);
            const mdlPointer = GuestMemory.guestAllocBytes(MDL.PFN_ARRAY +
                                                           pageCount * 8);
            GuestMemory.writeGuest64(mdlPointer + MDL.NEXT, 0);
            GuestMemory.writeGuest16(mdlPointer + MDL.SIZE,
                                     MDL.PFN_ARRAY + pageCount * 8);
            GuestMemory.writeGuest16(mdlPointer + MDL.MDL_FLAGS,
                                     MDL.FLAG_MAPPED_TO_SYSTEM_VA |
                                     MDL.FLAG_SOURCE_NONPAGED);
            GuestMemory.writeGuest64(mdlPointer + MDL.MAPPED_SYSTEM_VA,
                                     virtualAddress);   // identity-mapped
            GuestMemory.writeGuest64(mdlPointer + MDL.START_VA, startVa);
            GuestMemory.writeGuest32(mdlPointer + MDL.BYTE_COUNT, length >>> 0);
            GuestMemory.writeGuest32(mdlPointer + MDL.BYTE_OFFSET, byteOffset);
            // PFNs reais: VA -> frame fisico pelas tabelas de pagina
            const Paging = require('ntos/mm/paging');
            for (let page = 0; page < pageCount; page++) {
                const physical = Paging.translate(startVa + page * 0x1000);
                GuestMemory.writeGuest64(mdlPointer + MDL.PFN_ARRAY + page * 8,
                                         Math.floor(physical / 0x1000));
            }
            return mdlPointer;
        },
        // IoFreeMdl(mdlPtr)
        (mdlPointer) => { GuestMemory.guestFreeBytes(mdlPointer); return 0; },
        // IoGetCurrentThread() -> handle da thread nativa corrente
        () => KernelThreads.getCurrentThreadHandle(),
        // IoSetCancelRoutine(irpPtr, routinePtr) -> routine anterior (o NT
        // devolve a cancel routine previamente registrada no IRP)
        (ioRequestPointer, routinePointer) => {
            const previous = GuestMemory.readGuest64(ioRequestPointer +
                                                     NtAbi.IRP.CANCEL_ROUTINE);
            GuestMemory.writeGuest64(ioRequestPointer + NtAbi.IRP.CANCEL_ROUTINE,
                                     routinePointer >>> 0);
            return previous;
        },
        // IoCancelIrp(irpPtr): marca Cancel e chama a cancel routine do IRP
        // (PDRIVER_CANCEL = void (PDEVICE_OBJECT, PIRP); o device vem do slot)
        (ioRequestPointer) => {
            GuestMemory.writeGuest8(ioRequestPointer + NtAbi.IRP.CANCEL, 1);
            const cancelRoutine = GuestMemory.readGuest64(ioRequestPointer +
                                                          NtAbi.IRP.CANCEL_ROUTINE);
            if (!cancelRoutine) return 0;
            GuestMemory.writeGuest64(ioRequestPointer + NtAbi.IRP.CANCEL_ROUTINE, 0);
            const stackPointer = GuestMemory.readGuest32(ioRequestPointer +
                                                         NtAbi.IRP.CURRENT_STACK_LOCATION);
            const devicePointer = GuestMemory.readGuest32(stackPointer +
                                                          NtAbi.IO_STACK_LOCATION.DEVICE_OBJECT);
            os.execMsAbi(cancelRoutine, devicePointer, ioRequestPointer);
            return 0;
        },
        // IoAllocateDriverObjectExtension(drvObj, tagPtr, size, outPtr):
        // bloco de dados por driver, identificado pela tag (como o NT)
        (driverObjectPointer, tagPointer, size, outputPointer) => {
            const key = (driverObjectPointer >>> 0) + ':' +
                        (tagPointer >>> 0);
            if (driverExtensions.has(key)) return 0xC0000035 | 0;  // ja existe
            const extensionPointer = GuestMemory.guestAllocBytes(size >>> 0);
            driverExtensions.set(key, extensionPointer);
            GuestMemory.writeGuest64(outputPointer, extensionPointer);
            return 0;
        },
        // IoGetDriverObjectExtension(drvObj, tagPtr) -> extPtr ou 0
        (driverObjectPointer, tagPointer) =>
            driverExtensions.get((driverObjectPointer >>> 0) + ':' +
                                 (tagPointer >>> 0)) || 0,
        // IoGetCurrentProcess(): o MESMO caminho do NT — thread corrente ->
        // KTHREAD.ApcState.Process (offsets RE do ntoskrnl Win10 22H2)
        () => Process.getCurrentProcess(),
        // IoCreateFile(outHandle, access, objAttrs, ioStatus, allocSize,
        //              fileAttrs, share, createDisp, createOpts, eaBuf, eaLen,
        //              fileType, internalParams, options) — abertura completa
        // por nome: dispositivos via CREATE IRP, arquivos via ZwCreateFile
        (outHandlePointer, desiredAccess, objectAttributesPointer,
         ioStatusPointer, allocationSize, fileAttributes, shareAccess,
         createDisposition, createOptions, eaBuffer, eaLength, _fileType,
         _internalParams, _options) =>
            Zw.zwCreateFile(
                outHandlePointer, desiredAccess, objectAttributesPointer,
                ioStatusPointer, allocationSize, fileAttributes, shareAccess,
                createDisposition, createOptions, eaBuffer, eaLength),
        // IoGetRelatedDeviceObject(fileObjectPtr): FileObject->DeviceObject e
        // sobe a cadeia AttachedDevice ate o topo (como o NT)
        (fileObjectPointer) => {
            let devicePointer = GuestMemory.readGuest32(fileObjectPointer +
                NtAbi.FILE_OBJECT.DEVICE_OBJECT);
            for (;;) {
                const attached = GuestMemory.readGuest32(devicePointer +
                    NtAbi.DEVICE_OBJECT.ATTACHED_DEVICE);
                if (!attached) break;
                devicePointer = attached;
            }
            return devicePointer;
        },
        // IoGetDeviceProperty(devObj, property, outBuf, bufSize, outLenPtr)
        // DevicePropertyHardwareID=1: o id do PDO PCI (string wide) —
        // a assinatura real e' (devObj, property, bufferLength, outBuf, outLen)
        (devicePointer, property, bufferSize, outBufferPointer,
         outLengthPointer) => {
            if ((property >>> 0) === 0xB) {
                // DevicePropertyPhysicalDeviceObjectName: o NOME do PDO
                // ("\Device\I8042Kbd") — o NT anda ate o PDO da pilha; aqui
                // o chamador ja passa o PDO ou um device anexado a ele
                let candidate = devicePointer >>> 0;
                let nameNode = findDeviceNodeByPointer(candidate);
                while (!nameNode && pdoOfAttachedDevice.has(candidate)) {
                    candidate = pdoOfAttachedDevice.get(candidate);
                    nameNode = findDeviceNodeByPointer(candidate);
                }
                if (!nameNode) return 0xC0000034 | 0;
                const pdoName = '\\Device\\' + nameNode.name;
                const needed = (pdoName.length + 1) * 2;   // inclui o NUL
                if (bufferSize < needed) {
                    GuestMemory.writeGuest32(outLengthPointer, needed);
                    return 0xC0000023 | 0;   // STATUS_BUFFER_TOO_SMALL
                }
                for (let i = 0; i < pdoName.length; i++)
                    GuestMemory.writeGuest16(outBufferPointer + i * 2,
                                             pdoName.charCodeAt(i));
                GuestMemory.writeGuest16(outBufferPointer + pdoName.length * 2, 0);
                GuestMemory.writeGuest32(outLengthPointer, needed);
                return 0;
            }
            if ((property >>> 0) !== 1) return 0xC000000D | 0;
            // NT: a property de hardware mora no PDO — segue a cadeia de
            // attach ate achar o PDO PCI correspondente
            let candidate = devicePointer >>> 0;
            let pciFunction = PciBus.devices.find(pfn =>
                pfn.node && pfn.node.data.nativeDevicePointer === candidate);
            while (!pciFunction && pdoOfAttachedDevice.has(candidate)) {
                candidate = pdoOfAttachedDevice.get(candidate);
                pciFunction = PciBus.devices.find(pfn =>
                    pfn.node && pfn.node.data.nativeDevicePointer === candidate);
            }
            if (!pciFunction) return 0xC0000034 | 0;   // nao e' pilha PCI
            const id = PciBus.hardwareIdOf(pciFunction);
            const needed = (id.length + 2) * 2;
            if (bufferSize < needed) {
                GuestMemory.writeGuest32(outLengthPointer, needed);
                return 0xC0000023 | 0;   // STATUS_BUFFER_TOO_SMALL
            }
            for (let i = 0; i < id.length; i++)
                GuestMemory.writeGuest16(outBufferPointer + i * 2,
                                         id.charCodeAt(i));
            GuestMemory.writeGuest32(outLengthPointer, needed);
            return 0;
        },
        // IoGetStackLimits(outLowPtr, outHighPtr): os limites REAIS da pilha
        // do kernel (0x200000-0x300000, ver memory-map/stage2)
        (outLowPointer, outHighPointer) => {
            GuestMemory.writeGuest64(outLowPointer, 0x200000);
            GuestMemory.writeGuest64(outHighPointer, 0x300000);
            return 0;
        },
        // IoInitializeRemoveLockEx(lockPtr, allocTag, maxCount, maxIrp, size)
        (lockPointer, _allocTag, _maxCount, _maxIrp, _structSize) => {
            GuestMemory.writeGuest8(lockPointer + REMOVE_LOCK.REMOVED, 0);
            GuestMemory.writeGuest32(lockPointer + REMOVE_LOCK.IO_COUNT, 0);
            Dispatcher.initializeEvent(lockPointer + REMOVE_LOCK.WAIT_EVENT,
                                       0, 0);
            return 0;
        },
        // IoAcquireRemoveLockEx(lockPtr, tag, file, line, size) -> NTSTATUS
        (lockPointer) => {
            if (GuestMemory.readGuest8(lockPointer + REMOVE_LOCK.REMOVED))
                return 0xC0000056 | 0;   // STATUS_DELETE_PENDING
            GuestMemory.writeGuest32(lockPointer + REMOVE_LOCK.IO_COUNT,
                GuestMemory.readGuest32(lockPointer + REMOVE_LOCK.IO_COUNT) + 1);
            return 0;
        },
        // IoReleaseRemoveLockEx(lockPtr, tag, size)
        (lockPointer) => {
            const remaining = GuestMemory.readGuest32(lockPointer +
                REMOVE_LOCK.IO_COUNT) - 1;
            GuestMemory.writeGuest32(lockPointer + REMOVE_LOCK.IO_COUNT,
                                     remaining);
            if (remaining === 0 &&
                GuestMemory.readGuest8(lockPointer + REMOVE_LOCK.REMOVED))
                Dispatcher.setEvent(lockPointer + REMOVE_LOCK.WAIT_EVENT);
            return 0;
        },
        // IoReleaseRemoveLockAndWaitEx(lockPtr, tag, size): marca removido,
        // solta a referencia do caller e espera as pendentes zerarem
        (lockPointer) => {
            GuestMemory.writeGuest8(lockPointer + REMOVE_LOCK.REMOVED, 1);
            const remaining = GuestMemory.readGuest32(lockPointer +
                REMOVE_LOCK.IO_COUNT) - 1;
            GuestMemory.writeGuest32(lockPointer + REMOVE_LOCK.IO_COUNT,
                                     remaining);
            if (remaining > 0)
                Dispatcher.waitForSingleObject(lockPointer +
                                               REMOVE_LOCK.WAIT_EVENT, 0);
            return 0;
        },
        // IoAllocateErrorLogEntry(objectPtr, entrySize) -> bloco no pool
        (_objectPointer, entrySize) => GuestMemory.guestAllocBytes(entrySize),
        // IoWriteErrorLogEntry(entryPtr): grava no log do sistema (serial)
        (entryPointer) => {
            const errorCode = GuestMemory.readGuest32(entryPointer + 4);
            os.debugPrint('[errorlog] codigo=0x' + errorCode.toString(16));
            GuestMemory.guestFreeBytes(entryPointer);
            return 0;
        },
        // IoAcquireCancelSpinLock(outIrqlPtr): o spinlock global de cancel
        (outIrqlPointer) => {
            if (!cancelSpinLockPointer) {
                cancelSpinLockPointer = GuestMemory.guestAllocBytes(8);
                GuestMemory.writeGuest32(cancelSpinLockPointer, 0);
            }
            const oldIrql = Irql.getIrql();
            Irql.raiseIrql(Irql.DISPATCH_LEVEL);
            for (;;) {
                if (GuestMemory.readGuest32(cancelSpinLockPointer) === 0) {
                    GuestMemory.writeGuest32(cancelSpinLockPointer, 1);
                    break;
                }
            }
            GuestMemory.writeGuest32(outIrqlPointer, oldIrql);
            return 0;
        },
        // IoReleaseCancelSpinLock(oldIrql)
        (oldIrql) => {
            GuestMemory.writeGuest32(cancelSpinLockPointer, 0);
            Irql.lowerIrql(oldIrql >>> 0);
            return 0;
        },
        // IoRegisterDeviceInterface(pdoPtr, guidPtr, refStringPtr, outNamePtr):
        // cria \DosDevices\#{guid}#{ref} -> device e registra desabilitada
        (pdoPointer, guidPointer, _refStringPointer, outNamePointer) => {
            let guidText = '';
            for (let i = 0; i < 16; i++)
                guidText += GuestMemory.readGuest8(guidPointer + i)
                    .toString(16).padStart(2, '0');
            const driverRoot = ObjectManager.lookup('\\Device');
            let deviceName = 'PDO0';
            if (driverRoot && driverRoot.children)
                for (const child of driverRoot.children.values())
                    if (child.data && child.data.nativeDevicePointer === pdoPointer)
                        deviceName = child.name;
            const linkName = '\\DosDevices\\#{' + guidText + '}';
            ObjectManager.createSymlink(linkName, '\\Device\\' + deviceName);
            deviceInterfaces.set(linkName, { enabled: false, deviceName });
            const nameBuffer = GuestMemory.guestAllocBytes(linkName.length * 2 + 2);
            GuestStrings.writeGuestWideString(nameBuffer, linkName);
            GuestMemory.writeGuest16(outNamePointer, linkName.length * 2);
            GuestMemory.writeGuest16(outNamePointer + 2, linkName.length * 2 + 2);
            GuestMemory.writeGuest64(outNamePointer + 8, nameBuffer);
            return 0;
        },
        // IoSetDeviceInterfaceState(symlinkUniPtr, enable): habilita a
        // interface e dispara as notificacoes PnP registradas
        (symlinkPointer, enable) => {
            const linkName = GuestStrings.readUnicodeString(symlinkPointer);
            const interfaceEntry = deviceInterfaces.get(linkName);
            if (!interfaceEntry) return 0xC0000034 | 0;
            interfaceEntry.enabled = (enable & 0xFF) !== 0;
            if (interfaceEntry.enabled) {
                for (const registration of plugPlayRegistrations) {
                    const nameBuffer = GuestMemory.guestAllocBytes(
                        linkName.length * 2 + 2);
                    GuestStrings.writeGuestWideString(nameBuffer, linkName);
                    os.execMsAbi(registration.callbackPointer, nameBuffer,
                                 registration.contextPointer);
                }
            }
            return 0;
        },
        // IoRegisterPlugPlayNotification(category, flags, callbackPtr, drvObj,
        //                                context) -> handle de registro
        (_category, _flags, callbackPointer, _driverObject, contextPointer) => {
            const registration = { callbackPointer: callbackPointer >>> 0,
                                   contextPointer: contextPointer >>> 0 };
            plugPlayRegistrations.push(registration);
            return 0;   // NTSTATUS sucesso
        },
        // IoUnregisterPlugPlayNotification(registrationHandle)
        (registrationPointer) => {
            const index = plugPlayRegistrations.findIndex(r =>
                r.callbackPointer === (registrationPointer >>> 0));
            if (index < 0) return 0xC0000034 | 0;
            plugPlayRegistrations.splice(index, 1);
            return 0;
        },
        // IoRegisterDriverReinitialization(drvObj, routinePtr, contextPtr):
        // a rotina roda DEPOIS da inicializacao dos drivers de boot (NT)
        (_driverObject, routinePointer, contextPointer) => {
            Lifecycle.registerReinitialization(routinePointer >>> 0,
                                               contextPointer >>> 0);
            return 0;
        },
        // IoOpenDeviceRegistryKey(devicePtr, access, outKeyHandlePtr): a
        // chave de servico do driver dono do device (caminho real do Enum)
        (devicePointer, _access, outKeyHandlePointer) => {
            const driverRoot = ObjectManager.lookup('\\Device');
            let driverNode = null;
            if (driverRoot && driverRoot.children)
                for (const child of driverRoot.children.values())
                    if (child.data && child.data.nativeDevicePointer === devicePointer &&
                        child.data.driver)
                        driverNode = child.data.driver;
            if (!driverNode) return 0xC0000034 | 0;
            const keyHandle = Registry.open(
                '\\Registry\\Machine\\System\\Services\\' + driverNode.data.name);
            if (!keyHandle) return 0xC0000034 | 0;
            GuestMemory.writeGuest64(outKeyHandlePointer, keyHandle);
            return 0;
        },
        // IoWMIRegistrationControl(devicePtr, action): registra/desregistra
        // as classes WMI do device (action 0=register 1=unregister)
        (devicePointer, action) => {
            if ((action >>> 0) === 0)
                wmiRegisteredDevices.add(devicePointer >>> 0);
            else
                wmiRegisteredDevices.delete(devicePointer >>> 0);
            return 0;
        },
        // IoConnectInterrupt(outKiPtr, isr, context, spinlock, vector, irql,
        //                    syncIrql, mode, shareable, affinity, floatSave):
        // cria o KINTERRUPT e liga o ISR nativo ao vetor (ntos/ke/interrupt-
        // object.js) — args 5+ vem da pilha, ja mascarados la dentro
        (outInterruptPointer, serviceRoutine, serviceContext, spinLockPointer,
         vector, irql, synchronizeIrql, interruptMode, shareVector, affinity,
         floatingSave) =>
            InterruptObject.ioConnectInterrupt(
                outInterruptPointer, serviceRoutine, serviceContext,
                spinLockPointer, vector, irql, synchronizeIrql, interruptMode,
                shareVector, affinity, floatingSave),
        // IoDisconnectInterrupt(ki): desliga e libera
        (kinterruptPointer) => {
            InterruptObject.ioDisconnectInterrupt(kinterruptPointer >>> 0);
            return 0;
        },
        // IoCreateController(sizeExtension) -> CONTROLLER_OBJECT
        (extensionSize) => Controller.ioCreateController(extensionSize),
        // IoDeleteController(controller)
        (controllerPointer) => {
            Controller.ioDeleteController(controllerPointer >>> 0);
            return 0;
        },
        // IoAllocateController(controller, device, routine, context):
        // serializa o acesso ao controlador (fila FIFO quando ocupado)
        (controllerPointer, deviceObjectPointer, routinePointer,
         contextPointer) => {
            Controller.ioAllocateController(controllerPointer >>> 0,
                deviceObjectPointer, routinePointer, contextPointer);
            return 0;
        },
        // IoFreeController(controller): libera e dispara o proximo
        (controllerPointer) => {
            Controller.ioFreeController(controllerPointer >>> 0);
            return 0;
        },
        // IoStartPacket(device, irp, keyPtr, cancelRoutine): StartIo real
        (devicePointer, irpPointer, sortKeyPointer, cancelRoutine) => {
            StartIo.ioStartPacket(devicePointer >>> 0, irpPointer,
                                  sortKeyPointer, cancelRoutine);
            return 0;
        },
        // IoStartNextPacket(device, cancelable)
        (devicePointer, cancelable) => {
            StartIo.ioStartNextPacket(devicePointer >>> 0, cancelable);
            return 0;
        },
        // IoSetStartIoAttributes(device, deferredStart, serialAccess)
        (devicePointer, deferredStartIo, serialAccess) => {
            StartIo.ioSetStartIoAttributes(devicePointer >>> 0,
                                           deferredStartIo, serialAccess);
            return 0;
        },
        // IoGetAttachedDeviceReference(devicePtr) -> topo da cadeia
        // AttachedDevice com a ReferenceCount incrementada (como o NT)
        (devicePointer) => {
            let topPointer = devicePointer >>> 0;
            for (;;) {
                const attached = GuestMemory.readGuest32(topPointer +
                    DEVICE.ATTACHED_DEVICE);
                if (!attached) break;
                topPointer = attached;
            }
            GuestMemory.writeGuest32(topPointer + DEVICE.REFERENCE_COUNT,
                GuestMemory.readGuest32(topPointer + DEVICE.REFERENCE_COUNT) + 1);
            return topPointer;
        },
        // IoInvalidateDeviceState(pdo): o NT sinaliza o PnP p/ re-avaliar o
        // device (QUERY_DEVICE_STATE). Registramos a invalidacao de verdade —
        // o conjunto e' consultado pelo fluxo PnP quando o estado muda.
        (devicePointer) => {
            invalidatedDevices.add(devicePointer >>> 0);
            return 0;
        },
        // IoQueryDeviceDescription(busType, busNumber, ...): a consulta REAL
        // na arvore \Hardware\Description (ntos/cm/hw-description.js), com o
        // callout do driver invocado (11 args da ABI do ntddk.h)
        (busTypePointer, busNumberPointer, controllerTypePointer,
         controllerNumberPointer, peripheralTypePointer,
         peripheralNumberPointer, calloutRoutine, contextPointer) =>
            HwDescription.queryDeviceDescription(
                busTypePointer, busNumberPointer, controllerTypePointer,
                controllerNumberPointer, peripheralTypePointer,
                peripheralNumberPointer, calloutRoutine, contextPointer),
    ],
};
