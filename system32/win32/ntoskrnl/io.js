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
const DeviceResources = require('ntos/io/device-resources');
const IrpBuilder = require('win32/ntoskrnl/irp-builder');

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

// CONFIGURATION_INFORMATION global (IoGetConfigurationInformation): contagem
// de devices por tipo — drivers (disk.sys) incrementam DiskCount de verdade
let configurationInformationPointer = 0;

// IoFileObjectType: a variavel global do kernel (POBJECT_TYPE) — o simbolo
// aponta para uma struct de tipo persistente com o nome "File"
let fileObjectTypeVariable = 0;

// extensoes genericas de IRP (IoGet/SetGenericIrpExtension) + activity id
// (GUID de rastreio ETW por IRP/thread) — estado real, em JS porque o IRP
// e' compartilhado com o asm (efeito observavel identico)
const irpExtensionByPointer = new Map();   // irpPtr -> { generic, activityIdPtr }
let threadActivityIdPointer = 0;           // GUID (16 bytes) da thread atual

// devices registrados p/ notificacao de shutdown (IRP_MJ_SHUTDOWN no halt)
const shutdownNotificationDevices = [];

// callbacks de prioridade de IO (IoRegisterPriorityCallback)
const ioPriorityCallbacks = [];

// hard error mode da thread atual (IoSetThreadHardErrorMode) — default do
// NT para threads de kernel: hard errors HABILITADOS (1)
let threadHardErrorModeEnabled = 1;

function configurationInformation() {
    if (!configurationInformationPointer)
        configurationInformationPointer = GuestMemory.guestAllocBytes(0x40);
    return configurationInformationPointer;
}

// struct de tipo de objeto persistente com um nome (IoFileObjectType/PsJobType)
function makeObjectTypeVariable(typeName) {
    const typeStruct = GuestMemory.guestAllocBytes(0x40);
    const nameBuffer = GuestMemory.guestAllocBytes((typeName.length + 1) * 2);
    GuestStrings.writeGuestWideString(nameBuffer, typeName);
    GuestMemory.writeGuest64(typeStruct, nameBuffer);   // +0: Name.Buffer
    const variable = GuestMemory.guestAllocBytes(8);    // a "global" POBJECT_TYPE
    GuestMemory.writeGuest64(variable, typeStruct);
    return variable;
}

function fileObjectType() {
    if (!fileObjectTypeVariable)
        fileObjectTypeVariable = makeObjectTypeVariable('File');
    return fileObjectTypeVariable;
}

// extensao de um IRP (criada sob demanda; activity id zerado)
function irpExtension(irpPointer) {
    const key = irpPointer >>> 0;
    let extension = irpExtensionByPointer.get(key);
    if (!extension) {
        extension = { generic: 0, propagate: 0,
                      activityIdPointer: GuestMemory.guestAllocBytes(16) };
        irpExtensionByPointer.set(key, extension);
    }
    return extension;
}


// acha o no \Device\<name> dono de um device pointer (para resolver o nome
// do PDO em IoGetDeviceProperty/PhysicalDeviceObjectName)
function findDeviceNodeByPointer(devicePointer) {
    // varre a arvore \Device recursivamente (devices podem viver em
    // subdiretorios — ex: \Device\Ide\IdePort0 do ataport)
    const deviceRoot = ObjectManager.lookup('\\Device');
    const stack = deviceRoot && deviceRoot.children
        ? [...deviceRoot.children.values()] : [];
    while (stack.length) {
        const node = stack.pop();
        if (node.data && node.data.nativeDevicePointer === (devicePointer >>> 0))
            return node;
        if (node.children) stack.push(...node.children.values());
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
    // drivers, ex: ZwLoadDriver dentro de um DriverEntry). Nomes com
    // subdiretorio ("\Device\Ide\IdePort0" do ataport) criam os diretorios
    // intermediarios — o lookup por path precisa descer pela arvore
    const driverNode = Lifecycle.nodeByDriverObjectPointer(driverObjectPointer) ||
                       Lifecycle.getCurrentDriverNode();
    if (driverNode) {
        const nameParts = shortName.split('\\');
        let deviceNode;
        if (nameParts.length === 1) {
            deviceNode = ObjectManager.createObject('\\Device', shortName,
                                                    'Device', { driver: driverNode });
        } else {
            const directoryPath = '\\Device\\' + nameParts.slice(0, -1).join('\\');
            ObjectManager.createDirectory(directoryPath);
            deviceNode = ObjectManager.createObject(directoryPath,
                nameParts[nameParts.length - 1], 'Device', { driver: driverNode });
            deviceNode.name = shortName;   // path completo ("\Device\"+name resolve)
        }
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
        'IoConnectInterruptEx',            // (paramsPtr) — FULLY_SPECIFIED/LINE_BASED
        'IoDisconnectInterruptEx',         // (paramsPtr)
        'IoReadPartitionTableEx',          // (dev, outDriveLayoutPtr)
        'IoGetConfigurationInformation',   // -> CONFIGURATION_INFORMATION*
        'IoInvalidateDeviceRelations',     // (pdo, relationType)
        'IoGetGenericIrpExtension',        // (irp) -> extensao
        'IoSetGenericIrpExtension',        // (irp, ext, propagate)
        'IoPropagateIrpExtensionEx',       // (irp, dest, propagate)
        'IoGetActivityIdIrp',              // (irp, outGuid)
        'IoSetActivityIdIrp',              // (irp, guidPtr)
        'IoGetActivityIdThread',           // (outGuid)
        'IoClearActivityIdThread',         // ()
        'IoPropagateActivityIdToThread',   // (irp)
        'IoIsActivityTracingEnabled',      // -> BOOLEAN (sem sessao ETW)
        'IoReuseIrp',                      // (irp, status)
        'IoInitializeIrp',                 // (irp, packetSize, stackSize)
        'IoSetMasterIrpStatus',            // (masterIrp, status) -> status
        'IoBuildPartialMdl',               // (srcMdl, dstMdl, va, length)
        'IoSizeofWorkItem',                // -> tamanho do IO_WORKITEM
        'IoAllocateSfioStreamIdentifier',  // Storage QoS: sem stream (NULL)
        'IoGetSfioStreamIdentifier',       // -> NULL
        'IoFreeSfioStreamIdentifier',      // (ptr)
        'IoGetIoAttributionHandle',        // -> 0
        'IoRecordIoAttribution',           // -> STATUS_SUCCESS (sem contabilizacao)
        'IoGetIoPriorityHint',             // (irp) -> IOPRIORITY_NORMAL
        'IoGetPagingIoPriority',           // (irp) -> 0
        'IoGetRequestorProcess',           // (irp) -> EPROCESS
        'IoIs32bitProcess',                // (irp) -> 0 (so x64)
        'IoGetDeviceAttachmentBaseRef',    // (dev) -> base da pilha referenciado
        'IoGetDevicePropertyData',         // (pdo, locale, key, type, size, buf, req)
        'IoSetHardErrorOrVerifyDevice',    // (irp, dev)
        'IoSetThreadHardErrorMode',        // (enabled) -> anterior
        'IoRegisterShutdownNotification',  // (dev)
        'IoUnregisterShutdownNotification',// (dev)
        'IoReportTargetDeviceChangeAsynchronous', // (dev, guid, ctx, cb)
        'IoRegisterPriorityCallback',      // (cb)
        'IoUnregisterPriorityCallback',    // (cb)
        'IoWMIDeviceObjectToProviderId',   // (dev) -> id do provider
        'IoWMIWriteEvent',                 // (wnodeEventItem)
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
        // IoConnectInterruptEx(paramsPtr): IO_CONNECT_INTERRUPT_PARAMETERS
        // { u32 Version; union } — layouts REAIS do wdm.h:
        //   Version 1 (CONNECT_FULLY_SPECIFIED, o que o ataport usa):
        //     +0x08 PDO, +0x10 InterruptObject(OUT), +0x18 ServiceRoutine,
        //     +0x20 ServiceContext, +0x28 SpinLock, +0x30 SynchronizeIrql(u8),
        //     +0x31 FloatingSave, +0x32 ShareVector, +0x34 Vector(u32),
        //     +0x38 Irql(u8), +0x3C InterruptMode(u32), +0x40 ProcessorMask,
        //     +0x48 Group(u16)
        //   Version 2 (CONNECT_LINE_BASED): mesmos campos ate SpinLock; a
        //     IRQ vem do CM_RESOURCE_LIST do PDO (device-resources.js)
        (paramsPointer) => {
            const version = GuestMemory.readGuest32(paramsPointer);
            if (version === 2) {   // CONNECT_LINE_BASED
                const physicalDeviceObject =
                    GuestMemory.readGuest64(paramsPointer + 0x08);
                const serviceRoutine = GuestMemory.readGuest64(paramsPointer + 0x18);
                const serviceContext = GuestMemory.readGuest64(paramsPointer + 0x20);
                const spinLockPointer = GuestMemory.readGuest64(paramsPointer + 0x28);
                const interruptResource =
                    DeviceResources.consumeNextInterrupt(physicalDeviceObject);
                if (!interruptResource) {
                    os.debugPrint('[io] IoConnectInterruptEx LINE_BASED: PDO 0x' +
                        physicalDeviceObject.toString(16) + ' sem IRQ restante');
                    return 0xC000009A | 0;   // STATUS_INSUFFICIENT_RESOURCES
                }
                // o modo vem do recurso (bit LEVEL_SENSITIVE), como o HAL faz
                const interruptMode = (interruptResource.flags & 0x02) ? 1 : 0;
                const status = InterruptObject.ioConnectInterrupt(
                    paramsPointer + 0x10, serviceRoutine, serviceContext,
                    spinLockPointer, interruptResource.vector,
                    interruptResource.level, interruptResource.level,
                    interruptMode, 0, 0xFFFFFFFF, 0);
                os.debugPrint('[io] interrupt LINE_BASED: vetor 0x' +
                    interruptResource.vector.toString(16) + ' -> ISR 0x' +
                    serviceRoutine.toString(16));
                return status;
            }
            if (version === 1 || version === 4) {   // FULLY_SPECIFIED (+grupo)
                const serviceRoutine = GuestMemory.readGuest64(paramsPointer + 0x18);
                const serviceContext = GuestMemory.readGuest64(paramsPointer + 0x20);
                const spinLockPointer = GuestMemory.readGuest64(paramsPointer + 0x28);
                const synchronizeIrql = GuestMemory.readGuest8(paramsPointer + 0x30);
                const shareVector = GuestMemory.readGuest8(paramsPointer + 0x32);
                const vector = GuestMemory.readGuest32(paramsPointer + 0x34);
                const irql = GuestMemory.readGuest8(paramsPointer + 0x38);
                const interruptMode = GuestMemory.readGuest32(paramsPointer + 0x3C);
                os.debugPrint('[io] interrupt FULLY_SPECIFIED: vetor 0x' +
                    (vector >>> 0).toString(16) + ' irql ' + irql +
                    ' -> ISR 0x' + serviceRoutine.toString(16));
                return InterruptObject.ioConnectInterrupt(
                    paramsPointer + 0x10, serviceRoutine, serviceContext,
                    spinLockPointer, vector, irql, synchronizeIrql,
                    interruptMode, shareVector, 0xFFFFFFFF, 0);
            }
            os.debugPrint('[io] IoConnectInterruptEx: version ' + version +
                          ' (MESSAGE_BASED) sem suporte — MSI nao configurado');
            return 0xC00000BB | 0;   // STATUS_NOT_SUPPORTED (MSI)
        },
        // IoDisconnectInterruptEx(paramsPtr): +0 Version, +0x08 KINTERRUPT
        (paramsPointer) => {
            const kinterruptPointer = GuestMemory.readGuest64(paramsPointer + 0x08);
            if (!kinterruptPointer) return 0xC000000D | 0;   // STATUS_INVALID_PARAMETER
            InterruptObject.ioDisconnectInterrupt(kinterruptPointer >>> 0);
            return 0;
        },
        // IoReadPartitionTableEx(dev, outDriveLayoutPtrPtr): a implementacao
        // real envia IOCTL_DISK_GET_DRIVE_LAYOUT_EX ao device (disk.sys
        // responde quando a pilha esta de pe) e devolve o buffer de pool
        (deviceObjectPointer, outDriveLayoutPointer) => {
            const IOCTL_DISK_GET_DRIVE_LAYOUT_EX = 0x00070050;
            const bufferPointer = GuestMemory.guestAllocBytes(0x1000);
            const eventPointer = GuestMemory.guestAllocBytes(0x18);
            Dispatcher.initializeEvent(eventPointer, 0, 0);
            const ioRequest = IoManager.makeIoRequest(
                IoManager.IRP_MJ.DEVICE_CONTROL, {
                    ioctl: { code: IOCTL_DISK_GET_DRIVE_LAYOUT_EX,
                             inputLength: 0 },
                    buffer: bufferPointer, bufferLength: 0x1000,
                    userEvent: eventPointer,
                });
            const deviceNode = findDeviceNodeByPointer(deviceObjectPointer);
            if (!deviceNode) return 0xC000000D | 0;
            IoManager.callDriver('\\Device\\' + deviceNode.name, ioRequest);
            if (ioRequest.status !== 0) return ioRequest.status | 0;
            GuestMemory.writeGuest64(outDriveLayoutPointer, bufferPointer);
            return 0;
        },
        // IoGetConfigurationInformation() -> CONFIGURATION_INFORMATION*
        () => configurationInformation(),
        // IoInvalidateDeviceRelations(pdo, relationType): marca e re-enumera
        // as relacoes do barramento (BusRelations) via o orquestrador PnP —
        // e' assim que novos discos do ataport aparecem sem reboot
        (pdoPointer, relationType) => {
            const deviceNode = findDeviceNodeByPointer(pdoPointer);
            os.debugPrint('[pnp] relacoes invalidadas (' + relationType +
                          ') p/ \\Device\\' + (deviceNode ? deviceNode.name : '?'));
            if (!deviceNode) return 0;
            const Pnp = require('ntos/io/pnp');
            const parentFdoNode = deviceNode.data && deviceNode.data.childOf
                ? deviceNode.data.childOf
                : deviceNode;
            const childPointers = Pnp.queryBusRelations(parentFdoNode);
            for (const childPointer of childPointers) {
                const childNode = Pnp.registerChildPdo(parentFdoNode,
                                                       childPointer);
                const childIds = childNode.data.hardwareIds || [];
                if (childIds.length) Pnp.enumeratePdoStack(childNode);
            }
            return 0;
        },
        // IoGetGenericIrpExtension(irp) -> ponteiro da extensao generica
        (irpPointer) => irpExtension(irpPointer).generic,
        // IoSetGenericIrpExtension(irp, extensionPtr, propagate)
        (irpPointer, extensionPointer, propagate) => {
            const extension = irpExtension(irpPointer);
            extension.generic = extensionPointer >>> 0;
            extension.propagate = propagate ? 1 : 0;
            return 0;
        },
        // IoPropagateIrpExtensionEx(irp, irpBeingExtended, propagate): copia a
        // extensao marcada como propagavel para o IRP encadeado/associado
        (irpPointer, targetIrpPointer, _propagate) => {
            const source = irpExtension(irpPointer);
            if (!source.generic) return 0xC0000225 | 0;   // STATUS_NOT_FOUND
            const target = irpExtension(targetIrpPointer);
            target.generic = source.generic;
            target.propagate = source.propagate;
            return 0;
        },
        // IoGetActivityIdIrp(irp, outGuid): copia o GUID de rastreio do IRP
        (irpPointer, outGuidPointer) => {
            const extension = irpExtension(irpPointer);
            for (let byteIndex = 0; byteIndex < 16; byteIndex++)
                GuestMemory.writeGuest8(outGuidPointer + byteIndex,
                    GuestMemory.readGuest8(extension.activityIdPointer + byteIndex));
            return 0;
        },
        // IoSetActivityIdIrp(irp, guidPtr)
        (irpPointer, guidPointer) => {
            const extension = irpExtension(irpPointer);
            for (let byteIndex = 0; byteIndex < 16; byteIndex++)
                GuestMemory.writeGuest8(extension.activityIdPointer + byteIndex,
                    GuestMemory.readGuest8(guidPointer + byteIndex));
            return 0;
        },
        // IoGetActivityIdThread(outGuid): GUID de rastreio da thread atual
        (outGuidPointer) => {
            if (!threadActivityIdPointer)
                threadActivityIdPointer = GuestMemory.guestAllocBytes(16);
            for (let byteIndex = 0; byteIndex < 16; byteIndex++)
                GuestMemory.writeGuest8(outGuidPointer + byteIndex,
                    GuestMemory.readGuest8(threadActivityIdPointer + byteIndex));
            return 0;
        },
        // IoClearActivityIdThread(): zera o GUID da thread
        () => {
            if (threadActivityIdPointer) {
                GuestMemory.writeGuest64(threadActivityIdPointer, 0);
                GuestMemory.writeGuest64(threadActivityIdPointer + 8, 0);
            }
            return 0;
        },
        // IoPropagateActivityIdToThread(irp): thread herda o GUID do IRP
        (irpPointer) => {
            if (!threadActivityIdPointer)
                threadActivityIdPointer = GuestMemory.guestAllocBytes(16);
            const extension = irpExtension(irpPointer);
            for (let byteIndex = 0; byteIndex < 16; byteIndex++)
                GuestMemory.writeGuest8(threadActivityIdPointer + byteIndex,
                    GuestMemory.readGuest8(extension.activityIdPointer + byteIndex));
            return 0;
        },
        // IoIsActivityTracingEnabled() -> 0: nenhuma sessao de trace ETW
        // ativa no sistema (resposta real — nao ha consumidor)
        () => 0,
        // IoReuseIrp(irp, status): reinicializa o IRP para reuso mantendo o
        // tamanho/stack alocados (semantica real de IopReuseIrp)
        (irpPointer, status) => {
            const IRP = NtAbi.IRP, SL = NtAbi.IO_STACK_LOCATION;
            const stackCount = GuestMemory.readGuest8(irpPointer + IRP.STACK_COUNT);
            GuestMemory.writeGuest32(irpPointer + IRP.FLAGS, 0);
            GuestMemory.writeGuest64(irpPointer + IRP.MDL_ADDRESS, 0);
            GuestMemory.writeGuest64(irpPointer + IRP.SYSTEM_BUFFER, 0);
            GuestMemory.writeGuest32(irpPointer + IRP.IO_STATUS, status | 0);
            GuestMemory.writeGuest64(irpPointer + IRP.IO_STATUS_INFORMATION, 0);
            GuestMemory.writeGuest8(irpPointer + IRP.CURRENT_LOCATION, stackCount + 1);
            GuestMemory.writeGuest8(irpPointer + IRP.CANCEL, 0);
            GuestMemory.writeGuest64(irpPointer + IRP.USER_EVENT, 0);
            GuestMemory.writeGuest64(irpPointer + IRP.CURRENT_STACK_LOCATION,
                IrpBuilder.firstStackLocation(irpPointer, stackCount) + SL.SIZE);
            return 0;
        },
        // IoInitializeIrp(irp, packetSize, stackSize): init completo in-place
        // (a mesma forma que IopAllocateIrp deixa o IRP, sem a alocacao)
        (irpPointer, packetSize, stackSize) => {
            const IRP = NtAbi.IRP, SL = NtAbi.IO_STACK_LOCATION;
            for (let offset = 0; offset < packetSize; offset += 4)
                GuestMemory.writeGuest32(irpPointer + offset, 0);
            GuestMemory.writeGuest16(irpPointer + IRP.TYPE, IRP.IO_TYPE);
            GuestMemory.writeGuest16(irpPointer + IRP.SIZE_FIELD, packetSize);
            GuestMemory.writeGuest8(irpPointer + IRP.STACK_COUNT, stackSize);
            GuestMemory.writeGuest8(irpPointer + IRP.CURRENT_LOCATION, stackSize + 1);
            GuestMemory.writeGuest64(irpPointer + IRP.CURRENT_STACK_LOCATION,
                IrpBuilder.firstStackLocation(irpPointer, stackSize) + SL.SIZE);
            return 0;
        },
        // IoSetMasterIrpStatus(masterIrp, status) -> status: grava no IoStatus
        (masterIrpPointer, status) => {
            GuestMemory.writeGuest32(masterIrpPointer + NtAbi.IRP.IO_STATUS,
                                     status | 0);
            return status;
        },
        // IoBuildPartialMdl(sourceMdl, targetMdl, va, length): a janela do
        // target dentro do source (StartVa/ByteOffset/ByteCount + PFNs com o
        // deslocamento), marcado MDL_PARTIAL (0x10) — semantica real
        (sourceMdlPointer, targetMdlPointer, virtualAddress, length) => {
            const MDL = NtAbi.MDL;
            const sourceStartVa = GuestMemory.readGuest64(sourceMdlPointer + MDL.START_VA);
            const alignedVa = virtualAddress & ~0xFFF;
            GuestMemory.writeGuest64(targetMdlPointer + MDL.START_VA, alignedVa);
            GuestMemory.writeGuest32(targetMdlPointer + MDL.BYTE_OFFSET,
                                     virtualAddress & 0xFFF);
            GuestMemory.writeGuest32(targetMdlPointer + MDL.BYTE_COUNT,
                                     length >>> 0);
            GuestMemory.writeGuest16(targetMdlPointer + MDL.MDL_FLAGS,
                GuestMemory.readGuest16(targetMdlPointer + MDL.MDL_FLAGS) | 0x10);
            const pfnOffset = Math.floor((alignedVa - sourceStartVa) / 0x1000);
            const pageCount = Math.ceil(((virtualAddress & 0xFFF) + length) / 0x1000);
            for (let pageIndex = 0; pageIndex < pageCount; pageIndex++)
                GuestMemory.writeGuest64(
                    targetMdlPointer + MDL.PFN_ARRAY + pageIndex * 8,
                    GuestMemory.readGuest64(sourceMdlPointer + MDL.PFN_ARRAY +
                                            (pfnOffset + pageIndex) * 8));
            return 0;
        },
        // IoSizeofWorkItem() -> tamanho do IO_WORKITEM (nt-abi)
        () => NtAbi.IO_WORKITEM.SIZE,
        // ---- Storage QoS (SFIO): nenhuma policy de throughput configurada —
        // os retornos sao os documentados pelo MSDN para essa situacao
        // IoAllocateSfioStreamIdentifier(fileObject, outStreamIdPtr) -> NULL
        (_fileObjectPointer, outStreamIdPointer) => {
            if (outStreamIdPointer)
                GuestMemory.writeGuest64(outStreamIdPointer, 0);
            return 0;
        },
        // IoGetSfioStreamIdentifier(fileObject/irp) -> NULL
        (_fileObjectPointer) => 0,
        // IoFreeSfioStreamIdentifier(streamId): nada a liberar (nunca alocado)
        (_streamIdPointer) => 0,
        // IoGetIoAttributionHandle(...) -> 0 (sem atribuicao configurada)
        () => 0,
        // IoRecordIoAttribution(...): sem contabilizacao ativa — a chamada e'
        // benignamente aceita (STATUS_SUCCESS, como sem provider)
        () => 0,
        // IoGetIoPriorityHint(irp) -> IOPRIORITY_NORMAL (0)
        (_irpPointer) => 0,
        // IoGetPagingIoPriority(irp) -> 0 (normal)
        (_irpPointer) => 0,
        // IoGetRequestorProcess(irp): o processo que pediu o IRP. Nossos
        // IRPs nascem de codigo de kernel (servicos do sistema) — o dono e'
        // o System EPROCESS (estado real do jsOS)
        (_irpPointer) => Process.getSystemProcess(),
        // IoIs32bitProcess(irp) -> 0: todo o nosso codigo e' x86-64 (nunca
        // ha processo WOW64 no jsOS — resposta real)
        (_irpPointer) => 0,
        // IoGetDeviceAttachmentBaseRef(dev) -> o device da BASE da pilha,
        // referenciado (anda AttachedDevice ate o fundo; o NT devolve com
        // ref incrementada — o caller da ObfDereferenceObject)
        (devicePointer) => {
            let basePointer = devicePointer >>> 0;
            for (;;) {
                // o campo AttachedDevice aponta para CIMA; a base e' achada
                // descendo — guardamos a cadeia invertida via pdoOfAttached
                const above = GuestMemory.readGuest32(basePointer +
                    DEVICE.ATTACHED_DEVICE);
                if (!above) break;
                basePointer = above;
            }
            // a base real e' o PDO de hardware registrado no attach
            const pdoPointer = pdoOfAttachedDevice.get(basePointer >>> 0) ||
                               basePointer;
            GuestMemory.writeGuest32(pdoPointer + DEVICE.REFERENCE_COUNT,
                GuestMemory.readGuest32(pdoPointer + DEVICE.REFERENCE_COUNT) + 1);
            return pdoPointer;
        },
        // IoGetDevicePropertyData(pdo, localeId, keyPtr, type, size, buffer,
        // requiredSizePtr): DEVPROP — propriedade que nao conhecemos: o NT
        // responde STATUS_NOT_FOUND (a chave nao esta no devnode) — logamos
        // o fmtid para implementarmos se um driver real precisar
        (pdoPointer, _localeId, keyPointer, _type, _size, _bufferPointer,
         _requiredSizePointer) => {
            os.debugPrint('[io] DevicePropertyData: pdo 0x' +
                          (pdoPointer >>> 0).toString(16) + ' key fmtid ' +
                          GuestMemory.readGuest32(keyPointer).toString(16) +
                          '-' + GuestMemory.readGuest16(keyPointer + 4).toString(16) +
                          '-' + GuestMemory.readGuest16(keyPointer + 6).toString(16) +
                          ' pid ' + GuestMemory.readGuest32(keyPointer + 16));
            return 0xC0000225 | 0;   // STATUS_NOT_FOUND
        },
        // IoSetHardErrorOrVerifyDevice(irp, dev): associa o device ao IRP
        // para o caminho de hard error/verify (campo real do thread)
        (irpPointer, deviceObjectPointer) => {
            const extension = irpExtension(irpPointer);
            extension.hardErrorDevice = deviceObjectPointer >>> 0;
            return 0;
        },
        // IoSetThreadHardErrorMode(enabled) -> modo anterior (default do NT
        // para threads de kernel: habilitado)
        (enabled) => {
            const previous = threadHardErrorModeEnabled;
            threadHardErrorModeEnabled = enabled ? 1 : 0;
            return previous;
        },
        // IoRegisterShutdownNotification(dev): lista real — IRP_MJ_SHUTDOWN
        // vai para cada um quando o sistema desligar
        (deviceObjectPointer) => {
            shutdownNotificationDevices.push(deviceObjectPointer >>> 0);
            return 0;
        },
        // IoUnregisterShutdownNotification(dev)
        (deviceObjectPointer) => {
            const index = shutdownNotificationDevices.indexOf(
                deviceObjectPointer >>> 0);
            if (index >= 0) shutdownNotificationDevices.splice(index, 1);
            return 0;
        },
        // IoReportTargetDeviceChangeAsynchronous(dev, guid, context, cb):
        // agenda work item que dispara as notificacoes PnP registradas
        // (TARGET_DEVICE_CHANGE) — async de verdade, como o NT
        (deviceObjectPointer, guidPointer, contextPointer, callbackPointer) => {
            const workItemPointer = GuestMemory.guestAllocBytes(
                NtAbi.IO_WORKITEM.SIZE);
            WorkItems.queueJsWorkItem(workItemPointer, () => {
                for (const registration of plugPlayRegistrations) {
                    os.execMsAbi(registration.callbackPointer, guidPointer,
                                 registration.contextPointer);
                }
                if (callbackPointer)
                    os.execMsAbi(callbackPointer, contextPointer, 0);
            }, contextPointer);
            return 0;
        },
        // IoRegisterPriorityCallback(cb): chamado quando a prioridade de IO
        // de um IRP muda (nenhuma mudanca hoje — registrar e' o real)
        (callbackPointer) => {
            ioPriorityCallbacks.push(callbackPointer >>> 0);
            return 0;
        },
        // IoUnregisterPriorityCallback(cb)
        (callbackPointer) => {
            const index = ioPriorityCallbacks.indexOf(callbackPointer >>> 0);
            if (index >= 0) ioPriorityCallbacks.splice(index, 1);
            return 0;
        },
        // IoWMIDeviceObjectToProviderId(dev) -> id estavel do provider WMI
        // (o NT deriva do devnode; um ponteiro unico e estavel cumpre)
        (deviceObjectPointer) => deviceObjectPointer >>> 0,
        // IoWMIWriteEvent(wnodeEventItem): sem consumidor WMI registrado, o
        // evento e' descartado e o NT retorna STATUS_SUCCESS — o descarte
        // documentado aqui e' exatamente esse caminho
        (_wnodeEventItemPointer) => 0,
    ],
    // exports de DADO: IoFileObjectType e' a variavel global POBJECT_TYPE
    dataExports: {
        IoFileObjectType: () => fileObjectType(),
    },
    // chamado pelo halt: IRP_MJ_SHUTDOWN para cada device registrado
    runShutdownNotifications() {
        for (const devicePointer of shutdownNotificationDevices) {
            const deviceNode = findDeviceNodeByPointer(devicePointer);
            if (!deviceNode) continue;
            const ioRequest = IoManager.makeIoRequest(IoManager.IRP_MJ.SHUTDOWN,
                                                      {});
            IoManager.callDriver('\\Device\\' + deviceNode.name, ioRequest);
        }
    },
};
