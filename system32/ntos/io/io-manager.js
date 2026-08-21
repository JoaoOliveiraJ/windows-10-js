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
};

const STATUS = {
    SUCCESS:        0,
    NOT_FOUND:     -2,
    NOT_SUPPORTED: -3,
};

let nextIoRequestId = 1;

function makeIoRequest(majorFunction, parameters) {
    return { id: nextIoRequestId++, major: majorFunction,
             params: parameters || {},
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
// Layout do IRP na memoria do convidado (documentado em win32/ntoskrnl.js):
//   +0 u32 majorFunction, +4 u32 status, +8 u64 bufferPointer,
//   +16 u64 bufferLength, +24 u64 resultLength
// A pagina do dispositivo (4KB): +0x400 area do IRP, +0x800 buffer (2KB).

function writeGuest32(address, value) { os.writePhysical32(address, value >>> 0); }
function writeGuest64(address, value) {
    writeGuest32(address, value >>> 0);
    writeGuest32(address + 4, Math.floor(value / 0x100000000));
}

function callNativeDriver(device, ioRequestPacket) {
    const devicePointer = device.data.nativeDevicePointer;
    const driverObjectPointer = os.readPhysical32(devicePointer);
    const dispatchTable = os.readPhysical32(driverObjectPointer);
    const handlerAddress = os.readPhysical32(dispatchTable + ioRequestPacket.major * 8) +
                           os.readPhysical32(dispatchTable + ioRequestPacket.major * 8 + 4) * 0x100000000;
    if (!handlerAddress) {
        ioRequestPacket.status = STATUS.NOT_SUPPORTED;
        return ioRequestPacket;
    }

    const irpAddress = devicePointer + 0x400;
    const bufferAddress = devicePointer + 0x800;
    const data = ioRequestPacket.params.data;
    const dataLength = data ? String(data).length : 0;

    if (data && dataLength > 2048) {
        ioRequestPacket.status = STATUS.NOT_SUPPORTED;   // buffer de 2KB
        return ioRequestPacket;
    }
    if (data) {
        for (let i = 0; i < dataLength; i++)
            os.writePhysical8(bufferAddress + i, String(data).charCodeAt(i) & 0xFF);
    }

    writeGuest32(irpAddress + 0, ioRequestPacket.major);
    writeGuest32(irpAddress + 4, 0);                      // status
    writeGuest64(irpAddress + 8, bufferAddress);
    writeGuest64(irpAddress + 16, data ? dataLength : 2048);
    writeGuest64(irpAddress + 24, 0);                     // resultLength

    const guestStatus = os.execMsAbi(handlerAddress, devicePointer, irpAddress);

    ioRequestPacket.status = os.readPhysical32(irpAddress + 4) | 0;
    if (ioRequestPacket.status === 0 && guestStatus !== 0)
        ioRequestPacket.status = guestStatus;             // status pelo retorno
    ioRequestPacket.info = os.readPhysical32(irpAddress + 24);

    if (ioRequestPacket.major === IRP_MJ.READ && ioRequestPacket.info > 0) {
        let text = '';
        for (let i = 0; i < ioRequestPacket.info; i++)
            text += String.fromCharCode(os.readPhysical8(bufferAddress + i));
        ioRequestPacket.result = text;
    }
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

module.exports = { IRP_MJ, STATUS, makeIoRequest, init, createDriver, createDevice,
                   callDriver, read, write, deviceControl };
