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

// callbacks de power setting (PoRegisterPowerSettingCallback):
// { settingGuidText, callbackPointer, contextPointer, devicePointer } —
// disparados quando um setting muda (power-manager; hoje nenhum muda)
const powerSettingCallbacks = [];

// contadores de idle por device (PoRegisterDeviceForIdleDetection)
const idleCounterByDevice = new Map();

module.exports = {
    names: [
        'PoSetPowerState',       // (device, POWER_STATE_TYPE, POWER_STATE) -> anterior
        'PoStartNextPowerIrp',   // (irp)
        'PoCallDriver',          // (device, irp) -> NTSTATUS
        'PoRequestPowerIrp',     // (device, minor, state, completionPtr, ctxPtr, outIrpPtr)
        'PoRegisterPowerSettingCallback',   // (dev, guid, cb, ctx, outHandle)
        'PoUnregisterPowerSettingCallback', // (handle)
        'PoQueryWatchdogTime',              // (dev, outSeconds) -> BOOLEAN
        'PoRegisterDeviceForIdleDetection', // (dev, cons, perf, state) -> PULONG
        'PoSetDeviceBusyEx',                // (idlePointer)
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
            // a completion do power IRP tem a assinatura REAL do wdm.h:
            // (device, minorFunction, powerState, context, ioStatusBlock)
            if (completionPointer) {
                const ioStatusPointer = irpAddress + NtAbi.IRP.IO_STATUS;
                os.execMsAbi(completionPointer, devicePointer,
                             minorFunction >>> 0, powerState >>> 0,
                             contextPointer, ioStatusPointer);
            }
            GuestMemory.guestFreeBytes(irpAddress);
            return 0;
        },
        // PoRegisterPowerSettingCallback(dev, guidPtr, callback, context,
        // outHandlePtr): registro real — dispararia numa mudanca de setting
        (devicePointer, settingGuidPointer, callbackPointer, contextPointer,
         outHandlePointer) => {
            const entry = { callbackPointer: callbackPointer >>> 0,
                            contextPointer: contextPointer >>> 0,
                            devicePointer: devicePointer >>> 0,
                            settingGuidPointer: settingGuidPointer >>> 0 };
            powerSettingCallbacks.push(entry);
            if (outHandlePointer) GuestMemory.writeGuest64(outHandlePointer,
                                                           callbackPointer >>> 0);
            return 0;
        },
        // PoUnregisterPowerSettingCallback(handle)
        (handlePointer) => {
            const index = powerSettingCallbacks.findIndex(
                entry => entry.callbackPointer === (handlePointer >>> 0));
            if (index < 0) return 0xC0000225 | 0;
            powerSettingCallbacks.splice(index, 1);
            return 0;
        },
        // PoQueryWatchdogTime(dev, outSecondsPtr) -> 0: nenhum watchdog timer
        // armado no sistema (resposta real; *seconds = 0)
        (_devicePointer, outSecondsPointer) => {
            if (outSecondsPointer)
                GuestMemory.writeGuest32(outSecondsPointer, 0);
            return 0;
        },
        // PoRegisterDeviceForIdleDetection(dev, conservationTime,
        // performanceTime, state) -> PULONG: o contador de idle real do
        // device (o NT devolve NULL quando nao suporta — nos suportamos:
        // o contador e' o mecanismo, zerado por PoSetDeviceBusyEx)
        (devicePointer, _conservationIdleTime, _performanceIdleTime, _state) => {
            const counterPointer = GuestMemory.guestAllocBytes(4);
            idleCounterByDevice.set(devicePointer >>> 0, counterPointer);
            return counterPointer;
        },
        // PoSetDeviceBusyEx(idlePointer): reseta o contador de idle
        (idlePointer) => {
            GuestMemory.writeGuest32(idlePointer, 0);
            return 0;
        },
    ],
};
