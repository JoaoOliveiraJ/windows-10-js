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
    PNP:            0x1B,
};

const STATUS = {
    SUCCESS:        0,
    NOT_FOUND:     -2,
    NOT_SUPPORTED: -3,
};

// minor codes do IRP_MJ_PNP
const IRP_MN = {
    START_DEVICE: 0,
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
    const bufferLength = ioRequestPacket.major === IRP_MJ.WRITE ? dataLength : 2048;

    const bufferAddress = GuestMemory.guestAllocBytes(Math.max(1, bufferLength));
    if (data)
        for (let i = 0; i < dataLength; i++)
            GuestMemory.writeGuest8(bufferAddress + i, String(data).charCodeAt(i) & 0xFF);

    const irpAddress = GuestMemory.guestAllocBytes(NtAbi.IRP.STRUCT_SIZE +
                                                   NtAbi.IRP.STACK_LOCATION_SIZE);
    IrpBuilder.build(irpAddress, {
        major: ioRequestPacket.major,
        minor: ioRequestPacket.minor,
        buffer: bufferAddress,
        bufferLength,
        deviceObject: devicePointer,
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
    GuestMemory.guestFreeBytes(bufferAddress);
    return ioRequestPacket;
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

module.exports = { IRP_MJ, IRP_MN, STATUS, makeIoRequest, init, createDriver,
                   createDevice, callDriver, read, write, deviceControl,
                   pnpStartDevice };
