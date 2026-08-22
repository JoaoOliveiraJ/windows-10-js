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
    POWER:          0x16,
    PNP:            0x1B,
};

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

function callNativeDriver(device, ioRequestPacket) {
    const devicePointer = device.data.nativeDevicePointer;
    const driverObjectPointer = GuestMemory.readGuest32(devicePointer +
                                                        NtAbi.DEVICE_OBJECT.DRIVER_OBJECT);
    const handlerAddress =
        GuestMemory.readGuest64(driverObjectPointer + NtAbi.DRIVER_OBJECT.MAJOR_FUNCTION +
                                ioRequestPacket.major * 8);
    if (!handlerAddress) {
        ioRequestPacket.status = STATUS.NOT_SUPPORTED;
        return ioRequestPacket;
    }

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

    const irpAddress = GuestMemory.guestAllocBytes(NtAbi.IRP.STRUCT_SIZE +
                                                   NtAbi.IRP.STACK_LOCATION_SIZE);
    IrpBuilder.build(irpAddress, {
        major: ioRequestPacket.major,
        minor: ioRequestPacket.minor,
        buffer: bufferAddress,
        bufferLength: needsBuffer ? bufferLength : 0,
        deviceObject: devicePointer,
        power: ioRequestPacket.params.power,
    });

    const guestStatus = os.execMsAbi(handlerAddress, devicePointer, irpAddress);

    const ioStatus = IrpBuilder.readIoStatus(irpAddress);
    ioRequestPacket.status = ioStatus.status;
    if (ioRequestPacket.status === 0 && guestStatus !== 0)
        ioRequestPacket.status = guestStatus;             // status pelo retorno
    ioRequestPacket.info = ioStatus.information;

    if (ioRequestPacket.major === IRP_MJ.READ && ioRequestPacket.info > 0) {
        let text = '';
        for (let i = 0; i < ioRequestPacket.info; i++)
            text += String.fromCharCode(GuestMemory.readGuest8(bufferAddress + i));
        ioRequestPacket.result = text;
    }

    GuestMemory.guestFreeBytes(irpAddress);
    if (bufferAddress) GuestMemory.guestFreeBytes(bufferAddress);
    return ioRequestPacket;
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
                   pnpStartDevice, setDevicePowerState, queryDevicePowerState,
                   getDevicePowerState, dispatchNativePowerIrp };
