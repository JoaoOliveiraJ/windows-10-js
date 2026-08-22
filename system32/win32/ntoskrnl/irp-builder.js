// ===========================================================================
// jsOS - system32/win32/ntoskrnl/irp-builder.js: constroi IRPs REAIS na
// memoria do convidado (layout oficial do WDK, offsets em win32/nt-abi.js),
// com N stack locations (pilha de devices): a PRIMEIRA usada fica no
// endereco mais alto (slot StackCount-1), CurrentLocation = StackCount+1 e
// CurrentStackLocation aponta UMA ACIMA do topo — exatamente como o
// IopAllocateIrp do NT; cada IofCallDriver desce um nivel.
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');

const IRP = NtAbi.IRP, SL = NtAbi.IO_STACK_LOCATION;

// tamanho total de um IRP com `stackCount` stack locations
function sizeFor(stackCount) {
    return IRP.STRUCT_SIZE + Math.max(1, stackCount) * SL.SIZE;
}

// endereco da primeira stack location a ser usada (topo da pilha)
function firstStackLocation(irpAddress, stackCount) {
    return irpAddress + IRP.STRUCT_SIZE + (Math.max(1, stackCount) - 1) * SL.SIZE;
}

// constroi um IRP em `address` (area zerada pelo caller) pronto para o
// primeiro IofCallDriver: CL/CSL ainda apontam ACIMA do topo.
function build(address, { major, minor, buffer, bufferLength, deviceObject,
                          power, ioctl, stackCount, fileObject, byteOffset,
                          userEvent, userIosb, userBuffer, resources }) {
    const count = Math.max(1, stackCount || 1);
    for (let i = 0; i < sizeFor(count); i += 4)
        GuestMemory.writeGuest32(address + i, 0);

    GuestMemory.writeGuest16(address + IRP.TYPE, IRP.IO_TYPE);
    GuestMemory.writeGuest16(address + IRP.SIZE_FIELD, sizeFor(count));
    GuestMemory.writeGuest64(address + IRP.SYSTEM_BUFFER, buffer);
    GuestMemory.writeGuest8(address + IRP.STACK_COUNT, count);
    GuestMemory.writeGuest8(address + IRP.CURRENT_LOCATION, count + 1);
    GuestMemory.writeGuest64(address + IRP.CURRENT_STACK_LOCATION,
                             firstStackLocation(address, count) + SL.SIZE);
    if (userEvent) GuestMemory.writeGuest64(address + IRP.USER_EVENT, userEvent);
    if (userIosb) GuestMemory.writeGuest64(address + IRP.USER_IOSB, userIosb);
    if (userBuffer) GuestMemory.writeGuest64(address + IRP.USER_BUFFER, userBuffer);

    // preenche o slot do topo (o primeiro driver a receber o IRP)
    const stack = firstStackLocation(address, count);
    GuestMemory.writeGuest8(stack + SL.MAJOR, major);
    GuestMemory.writeGuest8(stack + SL.MINOR, minor);
    GuestMemory.writeGuest32(stack + SL.READ_LENGTH, bufferLength);
    GuestMemory.writeGuest64(stack + SL.READ_OFFSET, byteOffset || 0);
    GuestMemory.writeGuest64(stack + SL.DEVICE_OBJECT, deviceObject);
    GuestMemory.writeGuest64(stack + SL.FILE_OBJECT, fileObject || 0);

    // IRP_MJ_POWER: Parameters.Power.{Type,State} (uniao, por cima dos campos
    // de Read/Write — como no wdm.h)
    if (power) {
        GuestMemory.writeGuest32(stack + SL.POWER_TYPE, power.powerStateType);
        GuestMemory.writeGuest32(stack + SL.POWER_STATE, power.deviceState);
    }
    // IRP_MJ_DEVICE_CONTROL: Parameters.DeviceIoControl.{IoControlCode,...}
    if (ioctl) {
        GuestMemory.writeGuest32(stack + SL.IOCTL_CODE, ioctl.code);
        GuestMemory.writeGuest32(stack + SL.IOCTL_IN_LENGTH, ioctl.inputLength || 0);
        GuestMemory.writeGuest32(stack + SL.IOCTL_OUT_LENGTH, bufferLength);
    }
    // IRP_MJ_PNP/START_DEVICE: Parameters.StartDevice.AllocatedResources[*]
    if (resources) {
        GuestMemory.writeGuest64(stack + SL.PNP_ALLOCATED_RESOURCES, resources);
        GuestMemory.writeGuest64(stack + SL.PNP_ALLOCATED_RESOURCES_TRANSLATED,
                                 resources);
    }
}

// le o IoStatus apos a execucao do driver
function readIoStatus(address) {
    return {
        status: GuestMemory.readGuest32(address + IRP.IO_STATUS) | 0,  // NTSTATUS sinal
        information: GuestMemory.readGuest64(address + IRP.IO_STATUS_INFORMATION),
    };
}

module.exports = { build, readIoStatus, sizeFor, firstStackLocation };
