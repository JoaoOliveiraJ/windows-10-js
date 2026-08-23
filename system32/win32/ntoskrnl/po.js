// ===========================================================================
// jsOS - system32/win32/ntoskrnl/po.js: exports Po* com as assinaturas REAIS
// do WDK. A logica mora em ntos/po/power-manager.js (Power Manager do NT).
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const PowerManager = require('ntos/po/power-manager');
const IrpBuilder = require('win32/ntoskrnl/irp-builder');
const IoManager = require('ntos/io/io-manager');

// device dono de um IRP: Tail.Overlay.CurrentStackLocation->DeviceObject
function deviceOfIrp(ioRequestPointer) {
    const stackPointer = GuestMemory.readGuest32(ioRequestPointer +
                                                 NtAbi.IRP.CURRENT_STACK_LOCATION);
    return GuestMemory.readGuest32(stackPointer + NtAbi.IO_STACK_LOCATION.DEVICE_OBJECT);
}

module.exports = {
    names: [
        'PoSetPowerState',       // (device, POWER_STATE_TYPE, POWER_STATE) -> anterior
        'PoStartNextPowerIrp',   // (irp)
        'PoCallDriver',          // (device, irp) -> NTSTATUS
        'PoRequestPowerIrp',     // (device, minor, state, completionPtr, ctxPtr, outIrpPtr)
    ],
    handlers: [
        // PoSetPowerState(devicePtr, type, state) -> POWER_STATE anterior
        (devicePointer, powerStateType, newState) =>
            PowerManager.setPowerState(devicePointer, powerStateType >>> 0,
                                       newState >>> 0),
        // PoStartNextPowerIrp(irpPtr)
        (ioRequestPointer) => {
            PowerManager.startNextPowerRequest(deviceOfIrp(ioRequestPointer));
            return 0;
        },
        // PoCallDriver(devicePtr, irpPtr) -> NTSTATUS
        (devicePointer, ioRequestPointer) =>
            PowerManager.callDriverDownTheStack(devicePointer, ioRequestPointer),
        // PoRequestPowerIrp(devicePtr, minor, state, completionPtr, ctxPtr,
        //                   outIrpPtr): o Po constroi e despacha um power IRP
        // real (QUERY/SET) para o device — com completion se pedida
        (devicePointer, minorFunction, powerState, completionPointer,
         contextPointer, outIrpPointer) => {
            const stackCount = GuestMemory.readGuest8(devicePointer +
                NtAbi.DEVICE_OBJECT.STACK_SIZE) || 1;
            const irpAddress = GuestMemory.guestAllocBytes(
                IrpBuilder.sizeFor(stackCount));
            IrpBuilder.build(irpAddress, {
                major: 0x16,   // IRP_MJ_POWER
                minor: minorFunction >>> 0,
                buffer: 0,
                bufferLength: 0,
                deviceObject: devicePointer,
                stackCount,
                power: { powerStateType: 1, deviceState: powerState >>> 0 },
            });
            if (outIrpPointer) GuestMemory.writeGuest64(outIrpPointer, irpAddress);
            const status = IoManager.dispatchNativePowerIrp(devicePointer,
                                                            irpAddress);
            if (completionPointer)
                os.execMsAbi(completionPointer, devicePointer, irpAddress,
                             contextPointer) ;
            GuestMemory.guestFreeBytes(irpAddress);
            return 0;
        },
    ],
};
