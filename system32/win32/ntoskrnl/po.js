// ===========================================================================
// jsOS - system32/win32/ntoskrnl/po.js: exports Po* com as assinaturas REAIS
// do WDK. A logica mora em ntos/po/power-manager.js (Power Manager do NT).
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');
const PowerManager = require('ntos/po/power-manager');

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
    ],
};
