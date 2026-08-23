// ===========================================================================
// jsOS - system32/ntos/io/controller.js: CONTROLLER_OBJECT real (estilo NT).
//
// Serializa o acesso a um controlador de hardware compartilhado: se o
// controlador esta ocupado, o pedido (Device + routine + context) entra numa
// fila FIFO; IoFreeController libera e dispara o proximo. E' o modelo do
// 8042 (um so controlador p/ teclado+mouse) — ver wdm.h IoAllocateController.
//
// PIO_CONTROLLER... nao: CONTROLLER_OBJECT + IO_ALLOCATION_ACTION:
//   routine(deviceObject, irp/Context, mapRegisterBase, context) -> action
//   (0=KeepObject, 1=DeallocateObject... no NT o retorno decide se libera)
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const CO = NtAbi.CONTROLLER_OBJECT;

// filas por controlador: controllerPointer -> [{deviceObject, routine, context}]
const queueByController = new Map();

function readGuest32(a) { return os.readPhysical32(a) >>> 0; }
function readGuest64(a) {
    return os.readPhysical32(a) + os.readPhysical32(a + 4) * 0x100000000;
}
function writeGuest32(a, v) { os.writePhysical32(a, v >>> 0); }
function writeGuest64(a, v) {
    os.writePhysical32(a, v >>> 0);
    os.writePhysical32(a + 4, Math.floor(v / 0x100000000) >>> 0);
}

// dispara o proximo pedido da fila quando o controlador libera
function pump(controllerPointer) {
    const queue = queueByController.get(controllerPointer);
    if (!queue || queue.length === 0) return;
    const request = queue.shift();
    // roda a rotina do pedido (PDRIVER_CONTROL):
    // action = routine(deviceObject, device->CurrentIrp, mapRegisterBase,
    //                  context) — o Irp e' o CurrentIrp do device (wdm.h)
    const currentIrp = readGuest64(request.deviceObjectPointer +
                                   NtAbi.DEVICE_OBJECT.CURRENT_IRP);
    const action = os.execMsAbi(request.routinePointer,
                                request.deviceObjectPointer, currentIrp,
                                request.mapRegisterBase, request.contextPointer);
    writeGuest32(controllerPointer + CO.QUEUED, queue.length);
    // DeallocateObject (1): libera o controlador e segue a fila
    if ((action >>> 0) !== 0) {
        os.writePhysical8(controllerPointer + CO.BUSY, 0);
        pump(controllerPointer);
    }
}

// IoCreateController(sizeExtension) -> CONTROLLER_OBJECT zerado
function ioCreateController(extensionSize) {
    const controllerPointer = GuestMemory.guestAllocBytes(
        CO.SIZE + (extensionSize >>> 0));
    writeGuest32(controllerPointer + CO.TYPE,
                 CO.TYPE_CONTROLLER | (CO.SIZE << 16));
    writeGuest32(controllerPointer + CO.REFERENCE_COUNT, 1);
    os.writePhysical8(controllerPointer + CO.BUSY, 0);
    writeGuest32(controllerPointer + CO.QUEUED, 0);
    if (extensionSize >>> 0 > 0)
        writeGuest64(controllerPointer + CO.CONTROLLER_EXTENSION,
                     controllerPointer + CO.SIZE);
    queueByController.set(controllerPointer, []);
    return controllerPointer;
}

// IoDeleteController(controller): o NT so permite com a fila vazia
function ioDeleteController(controllerPointer) {
    queueByController.delete(controllerPointer);
    GuestMemory.guestFreeBytes(controllerPointer);
}

// IoAllocateController(controller, deviceObject, routine, context):
// se livre -> executa ja; se ocupado -> fila FIFO (como o NT)
function ioAllocateController(controllerPointer, deviceObjectPointer,
                              routinePointer, contextPointer) {
    if (os.readPhysical8(controllerPointer + CO.BUSY) === 0) {
        os.writePhysical8(controllerPointer + CO.BUSY, 1);
        // routine(deviceObject, device->CurrentIrp, mapRegisterBase=NULL,
        //         context) — o Irp e' o CurrentIrp do device (wdm.h)
        const currentIrp = readGuest64(deviceObjectPointer +
                                       NtAbi.DEVICE_OBJECT.CURRENT_IRP);
        const action = os.execMsAbi(routinePointer, deviceObjectPointer,
                                    currentIrp, 0, contextPointer);
        if ((action >>> 0) !== 0) {
            os.writePhysical8(controllerPointer + CO.BUSY, 0);
            pump(controllerPointer);
        }
        return;
    }
    queueByController.get(controllerPointer).push({
        deviceObjectPointer: deviceObjectPointer >>> 0,
        routinePointer: routinePointer >>> 0,
        contextPointer: contextPointer >>> 0,
        mapRegisterBase: 0,
    });
    writeGuest32(controllerPointer + CO.QUEUED,
                 queueByController.get(controllerPointer).length);
}

// IoFreeController(controller): libera e dispara o proximo da fila
function ioFreeController(controllerPointer) {
    os.writePhysical8(controllerPointer + CO.BUSY, 0);
    pump(controllerPointer);
}

module.exports = { ioCreateController, ioDeleteController,
                   ioAllocateController, ioFreeController };
