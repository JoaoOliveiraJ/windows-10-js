// ===========================================================================
// jsOS - system32/ntos/io/io-manager.js: I/O Manager estilo Windows NT.
//
// Toda leitura/escrita em dispositivo vira um IRP (I/O Request Packet) que o
// I/O Manager entrega a rotina de dispatch do driver dono do DeviceObject.
// Drivers se registram em \Driver\<Nome> e criam DeviceObjects em \Device\.
//
// Dois tipos de driver:
//  - JS:     dispatch = { [IRP_MJ_x]: (deviceObject, ioRequestPacket) => {} }
//  - nativo: driver .sys carregado pelo PE loader; o IRP e serializado para a
//            memoria do convidado e a rotina nativa e chamada via execMsAbi.
//
// Fluxo:  programa -> IoManager.read/write -> IRP -> dispatch do driver -> HW.
// ===========================================================================

const ObjectManager = require('ntos/ob/object-manager');

// Major function codes (subconjunto do NT)
const IRP_MJ = {
    CREATE:         0x00,
    CLOSE:          0x02,
    READ:           0x03,
    WRITE:          0x04,
    DEVICE_CONTROL: 0x0E,
    INTERNAL_DEVICE_CONTROL: 0x0F,
    CLEANUP:        0x12,
    POWER:          0x16,
    PNP:            0x1B,
};

// IRP.Flags (wdm.h): buffered + buffer alocado pelo I/O manager
const IRP_BUFFERED_IO = 0x02;
const IRP_DEALLOCATE_BUFFER = 0x10;

const STATUS = {
    SUCCESS:        0,
    NOT_FOUND:     -2,
    NOT_SUPPORTED: -3,
};

// minor codes do IRP_MJ_PNP / IRP_MJ_POWER (valores reais do wdm.h)
const IRP_MN = {
    START_DEVICE:  0,
    WAIT_WAKE:     0,
    POWER_SEQUENCE: 1,
    SET_POWER:     2,
    QUERY_POWER:   3,
};

let nextIoRequestId = 1;

function makeIoRequest(majorFunction, parameters) {
    return { id: nextIoRequestId++, major: majorFunction,
             params: parameters || {}, minor: (parameters && parameters.minor) || 0,
             status: STATUS.SUCCESS, result: null, info: 0 };
}

function init() {
    ObjectManager.createDirectory('\\Driver');
}

// cria \Driver\<name> (driver JS)
function createDriver(name, dispatch) {
    return ObjectManager.createObject('\\Driver', name, 'Driver',
                                      { name, dispatch, devices: [] });
}

// cria \Device\<name> ligado ao driver (JS ou nativo)
function createDevice(driverObject, name) {
    const device = ObjectManager.createObject('\\Device', name, 'Device',
                                              { driver: driverObject });
    driverObject.data.devices.push(device);
    return device;
}

// ---- dispatch para driver nativo (.sys) ----
//
// Constroi um IRP REAL (layout oficial do WDK, ver win32/nt-abi.js) na
// memoria do convidado e chama DriverObject->MajorFunction[major] do driver.

const IrpBuilder = require('win32/ntoskrnl/irp-builder');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const SL = NtAbi.IO_STACK_LOCATION;
const IRP = NtAbi.IRP;

// ---- IofCallDriver (semantica real do NT): desce um nivel na pilha --------
// CL--, CSL--, grava DeviceObject no slot e chama MajorFunction[major] do
// driver dono do device alvo. Usada pelo I/O Manager (primeiro despacho) e
// pelo export IoCallDriver (drivers repassando o IRP para baixo).
function iofCallDriver(devicePointer, ioRequestPointer) {
    const currentLocation = GuestMemory.readGuest8(ioRequestPointer + IRP.CURRENT_LOCATION);
    const stackCount = GuestMemory.readGuest8(ioRequestPointer + IRP.STACK_COUNT);
    if (currentLocation <= 1) {
        os.debugPrint('[iom] pilha estourada: irp=0x' +
                      (ioRequestPointer >>> 0).toString(16) +
                      ' CL=' + currentLocation + ' SC=' + stackCount +
                      ' dev=0x' + (devicePointer >>> 0).toString(16));
        return STATUS.NOT_SUPPORTED;
    }
    const stackPointer =
        GuestMemory.readGuest32(ioRequestPointer + IRP.CURRENT_STACK_LOCATION) - SL.SIZE;
    GuestMemory.writeGuest8(ioRequestPointer + IRP.CURRENT_LOCATION,
                            currentLocation - 1);
    GuestMemory.writeGuest64(ioRequestPointer + IRP.CURRENT_STACK_LOCATION,
                             stackPointer);
    GuestMemory.writeGuest64(stackPointer + SL.DEVICE_OBJECT, devicePointer);

    const major = GuestMemory.readGuest8(stackPointer + SL.MAJOR);
    const driverObjectPointer = GuestMemory.readGuest32(devicePointer +
                                                        NtAbi.DEVICE_OBJECT.DRIVER_OBJECT);
    const handlerAddress =
        GuestMemory.readGuest64(driverObjectPointer + NtAbi.DRIVER_OBJECT.MAJOR_FUNCTION +
                                major * 8);
    if (!handlerAddress) return STATUS.NOT_SUPPORTED;
    return os.execMsAbi(handlerAddress, devicePointer, ioRequestPointer) | 0;
}

// ---- IofCompleteRequest (semantica real do NT/ReactOS): --------------------
// Percorre da posicao atual ao topo: para cada slot, se o Control marcar
// SL_INVOKE_ON_SUCCESS/ERROR conforme o IoStatus, chama a completion routine
// com o DeviceObject do slot ACIMA (o IRP ja aponta p/ ele). O IRP sobe um
// nivel ANTES de cada chamada. STATUS_MORE_PROCESSING_REQUIRED interrompe.
function iofCompleteRequest(ioRequestPointer) {
    const stackCount = GuestMemory.readGuest8(ioRequestPointer + IRP.STACK_COUNT);
    let currentLocation = GuestMemory.readGuest8(ioRequestPointer + IRP.CURRENT_LOCATION);
    let currentStackPointer = GuestMemory.readGuest32(ioRequestPointer +
                                                      IRP.CURRENT_STACK_LOCATION);
    let slotUnderReview = currentStackPointer;
    currentLocation++;
    currentStackPointer += SL.SIZE;

    while (currentLocation <= stackCount + 1) {
        const control = GuestMemory.readGuest8(slotUnderReview + SL.CONTROL);
        const completionRoutine = GuestMemory.readGuest64(slotUnderReview +
                                                          SL.COMPLETION_ROUTINE);
        const status = IrpBuilder.readIoStatus(ioRequestPointer).status;
        const invoke = completionRoutine &&
            ((status >= 0 && (control & NtAbi.SL_INVOKE_ON_SUCCESS)) ||
             (status < 0 && (control & NtAbi.SL_INVOKE_ON_ERROR)));

        GuestMemory.writeGuest8(ioRequestPointer + IRP.CURRENT_LOCATION,
                                currentLocation);
        GuestMemory.writeGuest64(ioRequestPointer + IRP.CURRENT_STACK_LOCATION,
                                 currentStackPointer);

        if (invoke) {
            const deviceObject = currentLocation === stackCount + 1 ? 0 :
                GuestMemory.readGuest32(currentStackPointer + SL.DEVICE_OBJECT);
            const context = GuestMemory.readGuest64(slotUnderReview + SL.CONTEXT);
            const result = os.execMsAbi(completionRoutine, deviceObject,
                                        ioRequestPointer, context) | 0;
            if (result === NtAbi.STATUS.MORE_PROCESSING_REQUIRED) return result;
        }
        slotUnderReview += SL.SIZE;
        currentLocation++;
        currentStackPointer += SL.SIZE;
    }

    // finalizacao de IRP sincrono (NT): IoStatus -> UserIosb, SystemBuffer ->
    // UserBuffer (buffered I/O), UserEvent sinalizado
    const finalStatus = IrpBuilder.readIoStatus(ioRequestPointer);
    const userIosb = GuestMemory.readGuest64(ioRequestPointer + IRP.USER_IOSB);
    if (userIosb) {
        GuestMemory.writeGuest32(userIosb + NtAbi.IO_STATUS_BLOCK.STATUS,
                                 finalStatus.status >>> 0);
        GuestMemory.writeGuest64(userIosb + NtAbi.IO_STATUS_BLOCK.INFORMATION,
                                 finalStatus.information);
    }
    const userBuffer = GuestMemory.readGuest64(ioRequestPointer + IRP.USER_BUFFER);
    const systemBuffer = GuestMemory.readGuest64(ioRequestPointer + IRP.SYSTEM_BUFFER);
    if (userBuffer && systemBuffer && finalStatus.status >= 0 &&
        finalStatus.information > 0) {
        for (let i = 0; i < finalStatus.information; i++)
            GuestMemory.writeGuest8(userBuffer + i,
                                    GuestMemory.readGuest8(systemBuffer + i));
    }
    const userEvent = GuestMemory.readGuest64(ioRequestPointer + IRP.USER_EVENT);
    if (userEvent) require('ntos/ke/dispatcher').setEvent(userEvent);
    // IRP_BUFFERED_IO + DEALLOCATE_BUFFER: o SystemBuffer e' do I/O manager
    if (GuestMemory.readGuest32(ioRequestPointer + IRP.FLAGS) & IRP_DEALLOCATE_BUFFER) {
        if (systemBuffer) GuestMemory.guestFreeBytes(systemBuffer);
        GuestMemory.writeGuest64(ioRequestPointer + IRP.SYSTEM_BUFFER, 0);
    }
    return 0;
}

// ---- IRPs sincronos construidos por drivers (IoBuild*) ----------------------

// IoBuildSynchronousFsdRequest(major, device, buffer, length, offsetPtr,
//                              event, ioStatusBlock) -> IRP
// O buffer ja e' memoria de kernel: SystemBuffer aponta direto p/ ele.
function buildSynchronousFsdRequest(major, devicePointer, bufferPointer, length,
                                    byteOffsetPointer, eventPointer,
                                    ioStatusPointer) {
    const stackCount = GuestMemory.readGuest8(devicePointer +
                                              NtAbi.DEVICE_OBJECT.STACK_SIZE) || 1;
    const byteOffset = byteOffsetPointer
        ? GuestMemory.readGuest64(byteOffsetPointer) : 0;
    const irpAddress = GuestMemory.guestAllocBytes(IrpBuilder.sizeFor(stackCount));
    IrpBuilder.build(irpAddress, {
        major,
        minor: 0,
        buffer: bufferPointer,
        bufferLength: length >>> 0,
        deviceObject: devicePointer,
        stackCount,
        byteOffset,
        userEvent: eventPointer,
        userIosb: ioStatusPointer,
    });
    return irpAddress;
}

// IoBuildDeviceIoControlRequest(code, device, inBuf, inLen, outBuf, outLen,
//                               internal, event, ioStatusBlock) -> IRP
// METHOD_BUFFERED de verdade: input copiado p/ SystemBuffer na construcao;
// SystemBuffer -> OutputBuffer na conclusao (ver iofCompleteRequest).
function buildDeviceIoControlRequest(ioctlCode, devicePointer, inputBuffer,
                                     inputLength, outputBuffer, outputLength,
                                     internal, eventPointer, ioStatusPointer) {
    // internal e' BOOLEAN: o compilador grava so 1 byte no slot de 8 — ler so o byte
    const isInternal = (internal & 0xFF) !== 0;
    const stackCount = GuestMemory.readGuest8(devicePointer +
                                              NtAbi.DEVICE_OBJECT.STACK_SIZE) || 1;
    const systemBufferSize = Math.max(inputLength >>> 0, outputLength >>> 0, 1);
    const systemBuffer = GuestMemory.guestAllocBytes(systemBufferSize);
    if (inputBuffer)
        for (let i = 0; i < (inputLength >>> 0); i++)
            GuestMemory.writeGuest8(systemBuffer + i,
                                    GuestMemory.readGuest8(inputBuffer + i));
    const irpAddress = GuestMemory.guestAllocBytes(IrpBuilder.sizeFor(stackCount));
    IrpBuilder.build(irpAddress, {
        major: isInternal ? IRP_MJ.INTERNAL_DEVICE_CONTROL : IRP_MJ.DEVICE_CONTROL,
        minor: 0,
        buffer: systemBuffer,
        bufferLength: outputLength >>> 0,
        deviceObject: devicePointer,
        stackCount,
        ioctl: { code: ioctlCode >>> 0, inputLength: inputLength >>> 0 },
        userEvent: eventPointer,
        userIosb: ioStatusPointer,
        userBuffer: outputBuffer,
    });
    GuestMemory.writeGuest32(irpAddress + IRP.FLAGS,
                             IRP_BUFFERED_IO | IRP_DEALLOCATE_BUFFER);
    return irpAddress;
}

// cria um FILE_OBJECT real apontando para o device (um por handle aberto;
// anonimo/transiente nas chamadas sem handle)
function createFileObject(devicePointer) {
    const fileObjectPointer = GuestMemory.guestAllocBytes(NtAbi.FILE_OBJECT.STRUCT_SIZE);
    GuestMemory.writeGuest16(fileObjectPointer + NtAbi.FILE_OBJECT.TYPE, 5);
    GuestMemory.writeGuest16(fileObjectPointer + NtAbi.FILE_OBJECT.SIZE,
                             NtAbi.FILE_OBJECT.STRUCT_SIZE);
    GuestMemory.writeGuest64(fileObjectPointer + NtAbi.FILE_OBJECT.DEVICE_OBJECT,
                             devicePointer);
    return fileObjectPointer;
}

function callNativeDriver(device, ioRequestPacket) {
    // despacha para o TOPO da pilha de devices (filtros acima do dono)
    const devicePointer = device.data.stackTopPointer || device.data.nativeDevicePointer;
    const stackCount = GuestMemory.readGuest8(devicePointer + NtAbi.DEVICE_OBJECT.STACK_SIZE) || 1;
    // FILE_OBJECT da operacao: do handle, ou transiente (criado/liberado aqui)
    const transientFileObject = !ioRequestPacket.fileObjectPointer;
    const fileObjectPointer = ioRequestPacket.fileObjectPointer ||
                              createFileObject(devicePointer);

    const data = ioRequestPacket.params.data;
    const dataLength = data ? String(data).length : 0;
    // buffer de dados so existe p/ READ/WRITE/DEVICE_CONTROL (METHOD_BUFFERED)
    const needsBuffer = ioRequestPacket.major === IRP_MJ.READ ||
                        ioRequestPacket.major === IRP_MJ.WRITE ||
                        ioRequestPacket.major === IRP_MJ.DEVICE_CONTROL;
    const bufferLength = ioRequestPacket.major === IRP_MJ.WRITE ? dataLength : 2048;

    let bufferAddress = 0;
    if (needsBuffer) {
        bufferAddress = GuestMemory.guestAllocBytes(Math.max(1, bufferLength));
        if (data)
            for (let i = 0; i < dataLength; i++)
                GuestMemory.writeGuest8(bufferAddress + i, String(data).charCodeAt(i) & 0xFF);
    }

    const irpAddress = GuestMemory.guestAllocBytes(IrpBuilder.sizeFor(stackCount));
    IrpBuilder.build(irpAddress, {
        major: ioRequestPacket.major,
        minor: ioRequestPacket.minor,
        buffer: bufferAddress,
        bufferLength: needsBuffer ? bufferLength : 0,
        deviceObject: devicePointer,
        power: ioRequestPacket.params.power,
        stackCount,
        fileObject: fileObjectPointer,
        ioctl: ioRequestPacket.major === IRP_MJ.DEVICE_CONTROL
            ? { code: ioRequestPacket.params.controlCode >>> 0,
                inputLength: dataLength }
            : null,
    });

    const guestStatus = iofCallDriver(devicePointer, irpAddress);

    const ioStatus = IrpBuilder.readIoStatus(irpAddress);
    ioRequestPacket.status = ioStatus.status;
    if (ioRequestPacket.status === 0 && guestStatus !== 0)
        ioRequestPacket.status = guestStatus;             // status pelo retorno
    ioRequestPacket.info = ioStatus.information;

    if ((ioRequestPacket.major === IRP_MJ.READ ||
         ioRequestPacket.major === IRP_MJ.DEVICE_CONTROL) &&
        ioRequestPacket.info > 0) {
        let text = '';
        for (let i = 0; i < ioRequestPacket.info; i++)
            text += String.fromCharCode(GuestMemory.readGuest8(bufferAddress + i));
        ioRequestPacket.result = text;
    }

    GuestMemory.guestFreeBytes(irpAddress);
    if (bufferAddress) GuestMemory.guestFreeBytes(bufferAddress);
    if (transientFileObject) GuestMemory.guestFreeBytes(fileObjectPointer);
    return ioRequestPacket;
}

// ---- abertura/fechamento real: IRP_MJ_CREATE / IRP_MJ_CLOSE ----------------
// Um handle = um FILE_OBJECT vivo no convidado; CREATE vai ao topo da pilha.
let nextDeviceHandle = 1;
const openDeviceHandles = new Map();   // handle -> { device, fileObjectPointer }

function openDevice(devicePath) {
    const device = ObjectManager.lookup(devicePath);
    if (!device || device.type !== 'Device')
        return { status: STATUS.NOT_FOUND, handle: 0 };
    const topPointer = device.data.stackTopPointer || device.data.nativeDevicePointer;
    const fileObjectPointer = createFileObject(topPointer);
    const ioRequest = makeIoRequest(IRP_MJ.CREATE, {});
    ioRequest.fileObjectPointer = fileObjectPointer;
    callDriver(devicePath, ioRequest);
    if (ioRequest.status !== STATUS.SUCCESS) {
        GuestMemory.guestFreeBytes(fileObjectPointer);
        return { status: ioRequest.status, handle: 0 };
    }
    // handle aberto referencia o device (ObReferenceObject) — protege o
    // driver de unload enquanto houver handles (como o NT)
    const refCountAddress = topPointer + NtAbi.DEVICE_OBJECT.REFERENCE_COUNT;
    GuestMemory.writeGuest32(refCountAddress,
                             GuestMemory.readGuest32(refCountAddress) + 1);
    const handle = nextDeviceHandle++;
    openDeviceHandles.set(handle, { device, fileObjectPointer, topPointer });
    return { status: STATUS.SUCCESS, handle };
}

function closeDevice(handle) {
    const entry = openDeviceHandles.get(handle);
    if (!entry) return STATUS.NOT_FOUND;
    // ordem do NT: IRP_MJ_CLEANUP (ultimo handle do file object) e depois CLOSE
    const cleanupRequest = makeIoRequest(IRP_MJ.CLEANUP, {});
    cleanupRequest.fileObjectPointer = entry.fileObjectPointer;
    callDriver('\\Device\\' + entry.device.name, cleanupRequest);
    const closeRequest = makeIoRequest(IRP_MJ.CLOSE, {});
    closeRequest.fileObjectPointer = entry.fileObjectPointer;
    callDriver('\\Device\\' + entry.device.name, closeRequest);
    // solta a referencia do handle
    const refCountAddress = entry.topPointer + NtAbi.DEVICE_OBJECT.REFERENCE_COUNT;
    GuestMemory.writeGuest32(refCountAddress,
                             GuestMemory.readGuest32(refCountAddress) - 1);
    openDeviceHandles.delete(handle);
    GuestMemory.guestFreeBytes(entry.fileObjectPointer);
    return closeRequest.status;
}

// I/O num handle aberto (CREATE ja feito; o FILE_OBJECT e o do handle)
function readHandle(handle) {
    const entry = openDeviceHandles.get(handle);
    if (!entry) { const r = makeIoRequest(IRP_MJ.READ, {}); r.status = STATUS.NOT_FOUND; return r; }
    const ioRequest = makeIoRequest(IRP_MJ.READ, {});
    ioRequest.fileObjectPointer = entry.fileObjectPointer;
    return callDriver('\\Device\\' + entry.device.name, ioRequest);
}

function writeHandle(handle, data) {
    const entry = openDeviceHandles.get(handle);
    if (!entry) { const r = makeIoRequest(IRP_MJ.WRITE, {}); r.status = STATUS.NOT_FOUND; return r; }
    const ioRequest = makeIoRequest(IRP_MJ.WRITE, { data });
    ioRequest.fileObjectPointer = entry.fileObjectPointer;
    return callDriver('\\Device\\' + entry.device.name, ioRequest);
}

// ---- IRP_MJ_POWER: entrega um IRP JA construido na memoria do convidado ----
// Usado pelo PoCallDriver/PoStartNextPowerIrp (pilha de devices, fila Po).
function dispatchNativePowerIrp(devicePointer, ioRequestPointer) {
    const driverObjectPointer = GuestMemory.readGuest32(devicePointer +
                                                        NtAbi.DEVICE_OBJECT.DRIVER_OBJECT);
    const handlerAddress =
        GuestMemory.readGuest64(driverObjectPointer + NtAbi.DRIVER_OBJECT.MAJOR_FUNCTION +
                                IRP_MJ.POWER * 8);
    if (!handlerAddress) return STATUS.NOT_SUPPORTED;
    const guestStatus = os.execMsAbi(handlerAddress, devicePointer, ioRequestPointer);
    const ioStatus = IrpBuilder.readIoStatus(ioRequestPointer);
    return ioStatus.status !== 0 ? ioStatus.status : guestStatus;
}

// IoCallDriver: entrega o IRP ao driver dono do dispositivo
function callDriver(devicePath, ioRequestPacket) {
    const device = ObjectManager.lookup(devicePath);
    if (!device || device.type !== 'Device') {
        ioRequestPacket.status = STATUS.NOT_FOUND;
        return ioRequestPacket;
    }
    const driver = device.data.driver;
    if (driver.data.native)
        return callNativeDriver(device, ioRequestPacket);
    const handler = driver.data.dispatch[ioRequestPacket.major];
    if (!handler) {
        ioRequestPacket.status = STATUS.NOT_SUPPORTED;
        return ioRequestPacket;
    }
    handler(device, ioRequestPacket);
    return ioRequestPacket;
}

// helpers de conveniencia
function write(devicePath, data) {
    return callDriver(devicePath, makeIoRequest(IRP_MJ.WRITE, { data }));
}
function read(devicePath) {
    return callDriver(devicePath, makeIoRequest(IRP_MJ.READ, {}));
}
function deviceControl(devicePath, controlCode, parameters) {
    return callDriver(devicePath, makeIoRequest(IRP_MJ.DEVICE_CONTROL,
                      Object.assign({ controlCode }, parameters)));
}

// PnP: manda IRP_MJ_PNP / IRP_MN_START_DEVICE ao device e marca o resultado
function pnpStartDevice(device) {
    const ioRequest = makeIoRequest(IRP_MJ.PNP, { minor: IRP_MN.START_DEVICE });
    callDriver('\\Device\\' + device.name, ioRequest);
    device.data.pnpStarted = ioRequest.status === STATUS.SUCCESS;
    return ioRequest.status;
}

// ---- Power Manager: IRP_MJ_POWER SET/QUERY_POWER (device power state) ----
const PowerManager = require('ntos/po/power-manager');
const NtAbiPower = require('win32/nt-abi');

function sendPowerRequest(devicePath, minorFunction, deviceState) {
    const device = ObjectManager.lookup(devicePath);
    if (!device || device.type !== 'Device')
        return makeIoRequest(IRP_MJ.POWER, { minor: minorFunction,
                                             status: STATUS.NOT_FOUND });
    const devicePointer = device.data.nativeDevicePointer;
    const ioRequest = makeIoRequest(IRP_MJ.POWER, {
        minor: minorFunction,
        power: { powerStateType: NtAbiPower.POWER_STATE_TYPE.DEVICE_POWER_STATE,
                 deviceState },
    });
    // contabiliza no Power Manager: em processamento durante o dispatch
    if (devicePointer) PowerManager.markPowerRequestStarted(devicePointer);
    callDriver(devicePath, ioRequest);
    if (devicePointer) PowerManager.markPowerRequestDone(devicePointer);
    return ioRequest;
}

// Po: SET_POWER D0..D3 no device (o driver chama PoSetPowerState internamente)
function setDevicePowerState(devicePath, deviceState) {
    return sendPowerRequest(devicePath, IRP_MN.SET_POWER, deviceState);
}

// Po: QUERY_POWER (pergunta se o device aceita ir p/ deviceState)
function queryDevicePowerState(devicePath, deviceState) {
    return sendPowerRequest(devicePath, IRP_MN.QUERY_POWER, deviceState);
}

// estado de energia corrente registrado no Power Manager
function getDevicePowerState(devicePath) {
    const device = ObjectManager.lookup(devicePath);
    if (!device || device.type !== 'Device') return null;
    return PowerManager.getDevicePowerState(device.data.nativeDevicePointer);
}

module.exports = { IRP_MJ, IRP_MN, STATUS, makeIoRequest, init, createDriver,
                   createDevice, callDriver, read, write, deviceControl,
                   openDevice, closeDevice, readHandle, writeHandle,
                   pnpStartDevice, setDevicePowerState, queryDevicePowerState,
                   getDevicePowerState, dispatchNativePowerIrp,
                   iofCallDriver, iofCompleteRequest,
                   buildSynchronousFsdRequest, buildDeviceIoControlRequest };
