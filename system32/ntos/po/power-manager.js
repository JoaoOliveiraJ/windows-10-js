// ===========================================================================
// jsOS - system32/ntos/po/power-manager.js: Power Manager estilo NT (Po*).
//
// Mantem o estado de energia corrente de cada DEVICE_OBJECT (D0..D3), a fila
// de power IRPs pendentes por device e o encaminhamento pela pilha de devices
// (AttachedDevice), como o Po do ntoskrnl real:
//  - PoSetPowerState: driver notifica o estado novo; retorna o ANTERIOR
//    (semantica documentada no WDK).
//  - PoStartNextPowerIrp: dispara o proximo power IRP enfileirado no device.
//  - PoCallDriver: desce o power IRP pela pilha (AttachedDevice) ate o fundo.
// ===========================================================================

const NtAbi = require('win32/nt-abi');
const GuestMemory = require('win32/guest-memory');

// quem despacha power IRPs para baixo na pilha (registrado pelo I/O manager
// no carregamento — quebra o ciclo io-manager<->power-manager)
let powerIrpDispatcher = null;
function registerPowerIrpDispatcher(dispatchFunction) {
    powerIrpDispatcher = dispatchFunction;
}

const DEVICE = NtAbi.DEVICE_OBJECT;

// estado de energia corrente por device (devicePointer -> DEVICE_POWER_STATE)
const currentDevicePowerState = new Map();
// fila de power IRPs pendentes por device (devicePointer -> [irpPointer...])
const pendingPowerRequests = new Map();
// device com power IRP em processamento agora (dispatch e sincrono aqui)
const powerRequestInFlight = new Set();

function getDevicePowerState(devicePointer) {
    const state = currentDevicePowerState.get(devicePointer);
    return state === undefined ? NtAbi.DEVICE_POWER_STATE.D0 : state;
}

// PoSetPowerState(device, POWER_STATE_TYPE, POWER_STATE) -> estado ANTERIOR
function setPowerState(devicePointer, powerStateType, newState) {
    if (powerStateType !== NtAbi.POWER_STATE_TYPE.DEVICE_POWER_STATE)
        return newState;    // SystemPowerState nao e rastreado por device
    const previousState = getDevicePowerState(devicePointer);
    currentDevicePowerState.set(devicePointer, newState >>> 0);
    return previousState;
}

function forgetDevice(devicePointer) {
    currentDevicePowerState.delete(devicePointer);
    pendingPowerRequests.delete(devicePointer);
    powerRequestInFlight.delete(devicePointer);
}

// enfileira um power IRP atras do que estiver em processamento (como o NT)
function queuePowerRequest(devicePointer, ioRequestPointer) {
    if (!pendingPowerRequests.has(devicePointer))
        pendingPowerRequests.set(devicePointer, []);
    pendingPowerRequests.get(devicePointer).push(ioRequestPointer);
    return powerRequestInFlight.has(devicePointer);   // true = ficou na fila
}

function markPowerRequestStarted(devicePointer) {
    powerRequestInFlight.add(devicePointer);
}

function markPowerRequestDone(devicePointer) {
    powerRequestInFlight.delete(devicePointer);
}

// PoStartNextPowerIrp(irp): dispara o proximo power IRP enfileirado no device
function startNextPowerRequest(devicePointer) {
    const queue = pendingPowerRequests.get(devicePointer);
    if (!queue || queue.length === 0) return;
    const nextIrpPointer = queue.shift();
    powerIrpDispatcher(devicePointer, nextIrpPointer);
}

// PoCallDriver(device, irp): desce o IRP pela pilha AttachedDevice; no fundo
// da pilha (sem device abaixo) o IRP se completa com o status que ja tem.
function callDriverDownTheStack(devicePointer, ioRequestPointer) {
    const attachedDevice = GuestMemory.readGuest32(devicePointer +
                                                   DEVICE.ATTACHED_DEVICE);
    if (!attachedDevice) return 0;   // STATUS_SUCCESS: fundo da pilha
    return powerIrpDispatcher(attachedDevice, ioRequestPointer);
}

module.exports = { getDevicePowerState, setPowerState, forgetDevice,
                   queuePowerRequest, markPowerRequestStarted,
                   markPowerRequestDone, startNextPowerRequest,
                   callDriverDownTheStack, registerPowerIrpDispatcher };
