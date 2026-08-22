// ===========================================================================
// jsOS - system32/win32/ntoskrnl/irp-builder.js: constroi IRPs REAIS na
// memoria do convidado (layout oficial do WDK, offsets em win32/nt-abi.js).
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');

// constroi um IRP com 1 stack location em `address` (area zerada pelo caller)
function build(address, { major, minor, buffer, bufferLength, deviceObject, power }) {
    const IRP = NtAbi.IRP, SL = NtAbi.IO_STACK_LOCATION;
    for (let i = 0; i < IRP.STRUCT_SIZE + IRP.STACK_LOCATION_SIZE; i += 4)
        GuestMemory.writeGuest32(address + i, 0);

    GuestMemory.writeGuest16(address + IRP.TYPE, IRP.IO_TYPE);
    GuestMemory.writeGuest16(address + IRP.SIZE_FIELD,
                             IRP.STRUCT_SIZE + IRP.STACK_LOCATION_SIZE);
    GuestMemory.writeGuest64(address + IRP.SYSTEM_BUFFER, buffer);
    GuestMemory.writeGuest8(address + IRP.STACK_COUNT, 1);
    GuestMemory.writeGuest8(address + IRP.CURRENT_LOCATION, 1);
    GuestMemory.writeGuest64(address + IRP.CURRENT_STACK_LOCATION,
                             address + IRP.STRUCT_SIZE);

    const stack = address + IRP.STRUCT_SIZE;
    GuestMemory.writeGuest8(stack + SL.MAJOR, major);
    GuestMemory.writeGuest8(stack + SL.MINOR, minor);
    GuestMemory.writeGuest32(stack + SL.READ_LENGTH, bufferLength);
    GuestMemory.writeGuest64(stack + SL.READ_OFFSET, 0);
    GuestMemory.writeGuest64(stack + SL.DEVICE_OBJECT, deviceObject);

    // IRP_MJ_POWER: Parameters.Power.{Type,State} (uniao, por cima dos campos
    // de Read/Write — como no wdm.h)
    if (power) {
        GuestMemory.writeGuest32(stack + SL.POWER_TYPE, power.powerStateType);
        GuestMemory.writeGuest32(stack + SL.POWER_STATE, power.deviceState);
    }
}

// le o IoStatus apos a execucao do driver
function readIoStatus(address) {
    const IRP = NtAbi.IRP;
    return {
        status: GuestMemory.readGuest32(address + IRP.IO_STATUS) | 0,  // NTSTATUS sinal
        information: GuestMemory.readGuest64(address + IRP.IO_STATUS_INFORMATION),
    };
}

module.exports = { build, readIoStatus };
