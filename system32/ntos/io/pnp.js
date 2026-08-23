// ===========================================================================
// jsOS - system32/ntos/io/pnp.js: o orquestrador PnP (o papel do PnP Manager
// do NT): liga um driver funcional num PDO (AddDevice real), inicia a pilha
// (START_DEVICE com a CM_RESOURCE_LIST do PDO) e enumera filhos
// (QUERY_DEVICE_RELATIONS/BusRelations).
//
// A associacao driver<->device vem do Registry (Services) — como o NT faz
// pelo INF; aqui o Service Control sobe os drivers de boot e o orquestrador
// casa o hardwareId do PDO com o servico.
// ===========================================================================

const IoManager = require('ntos/io/io-manager');
const ObjectManager = require('ntos/ob/object-manager');
const Lifecycle = require('win32/ntoskrnl/lifecycle');
const WorkItems = require('ntos/io/work-items');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

// PDO -> driver funcional (o "INF estatico" do jsOS; hardwareId -> servico)
const FUNCTION_DRIVER_BY_ID = {
    PNP0303: 'i8042prt',   // controlador de teclado PS/2 -> port driver MS
    PNP0F13: 'i8042prt',   // mouse PS/2 -> mesmo port driver
};

// chama o AddDevice do driver funcional sobre o PDO e devolve o NOVO device
// (FDO) criado pelo driver durante a chamada
function attachFunctionDriver(pdoNode, driverName) {
    const driverNode = ObjectManager.lookup('\\Driver\\' + driverName);
    if (!driverNode) {
        os.debugPrint('[pnp] driver ' + driverName + ' nao carregado');
        return null;
    }
    const devicesBefore = new Set(driverNode.data.devices);
    const status = Lifecycle.callAddDevice(driverName,
                                           pdoNode.data.nativeDevicePointer);
    if (status !== 0) {
        os.debugPrint('[pnp] AddDevice de ' + driverName + ' falhou: 0x' +
                      (status >>> 0).toString(16));
        return null;
    }
    const newDevices = driverNode.data.devices.filter(d => !devicesBefore.has(d));
    const fdoNode = newDevices[0] || null;
    if (fdoNode) {
        // herda os recursos do PDO p/ o START_DEVICE da pilha
        fdoNode.data.resources = pdoNode.data.resources;
        fdoNode.data.pdoNode = pdoNode;
        os.debugPrint('[pnp] ' + driverName + ' anexado: FDO \\Device\\' +
                      fdoNode.name + ' sobre PDO \\Device\\' + pdoNode.name);
    }
    return fdoNode;
}

// manda um minor PNP qualquer para a pilha (helper interno)
function sendPnpMinor(fdoNode, minor, extraParams) {
    const params = Object.assign({ minor }, extraParams || {});
    const ioRequest = IoManager.makeIoRequest(IoManager.IRP_MJ.PNP, params);
    IoManager.callDriver('\\Device\\' + fdoNode.name, ioRequest);
    return ioRequest;
}

// START_DEVICE na pilha (recursos do PDO) + QUERY_DEVICE_RELATIONS depois
function startDeviceStack(fdoNode) {
    // a sequencia REAL do PnP antes do START (o NT manda estas queries na
    // pilha nessa ordem; o driver usa para montar a configuracao interna):
    // QUERY_CAPABILITIES leva o buffer DEVICE_CAPABILITIES ja alocado
    const capsPointer = GuestMemory.guestAllocBytes(0x40);
    sendPnpMinor(fdoNode, IoManager.IRP_MN.QUERY_CAPABILITIES,
                 { pnpSlotPointer: capsPointer });
    const requirementsRequest =
        sendPnpMinor(fdoNode, IoManager.IRP_MN.QUERY_RESOURCE_REQUIREMENTS);
    if (requirementsRequest.status === 0 && requirementsRequest.info) {
        // FILTER_RESOURCE_REQUIREMENTS com a lista que o PDO devolveu
        sendPnpMinor(fdoNode, IoManager.IRP_MN.FILTER_RESOURCE_REQUIREMENTS, {
            pnpSlotPointer: requirementsRequest.info,
        });
    }
    const status = IoManager.pnpStartDevice(fdoNode);
    os.debugPrint('[pnp] START_DEVICE \\Device\\' + fdoNode.name +
                  ' -> 0x' + (status >>> 0).toString(16));
    return status;
}

// QUERY_DEVICE_RELATIONS(BusRelations=0): o driver de barramento devolve os
// PDOs filhos (DEVICE_RELATIONS: u32 Count + PDEVICE_OBJECT[]) em
// IoStatus.Information — enumeracao real de filhos do NT
function queryBusRelations(fdoNode) {
    const ioRequest = IoManager.makeIoRequest(IoManager.IRP_MJ.PNP, {
        minor: IoManager.IRP_MN.QUERY_DEVICE_RELATIONS,
        relationsType: 0,   // BusRelations
    });
    IoManager.callDriver('\\Device\\' + fdoNode.name, ioRequest);
    if (ioRequest.status !== 0 || !ioRequest.info) return [];
    const count = GuestMemory.readGuest32(ioRequest.info);
    const children = [];
    for (let i = 0; i < count; i++)
        children.push(GuestMemory.readGuest32(ioRequest.info + 8 + i * 8));
    GuestMemory.guestFreeBytes(ioRequest.info);
    return children;   // ponteiros de DEVICE_OBJECT dos PDOs filhos
}

// QUERY_ID(HardwareIDs) num PDO (usado p/ casar o driver do filho)
function queryHardwareIds(devicePointer) {
    // desce pela pilha nativa ate o PDO — constroi um IRP de convidado
    // direcionado ao proprio PDO (dispatch JS do bus se DRIVER_OBJECT=0)
    const node = createdChildNodes.get(devicePointer >>> 0);
    if (node) return node.data.hardwareIds || [];
    return [];
}

// os filhos enumerados viram nos \Device\<PdoName> nossos (PDO: o driver de
// barramento responde as queries por eles via dispatch nativo dele)
const createdChildNodes = new Map();   // devicePointer -> node
let nextChildPdoIndex = 0;

function registerChildPdo(parentFdoNode, childDevicePointer) {
    // pergunta o hardware id ao barramento via QUERY_ID nativo no filho
    const name = parentFdoNode.name + '_PDO' + (nextChildPdoIndex++);
    const node = ObjectManager.createObject('\\Device', name, 'Device', {
        nativeDevicePointer: childDevicePointer,
        pdo: true,
        childOf: parentFdoNode,
    });
    createdChildNodes.set(childDevicePointer >>> 0, node);
    // QUERY_ID nativo: constroi IRP_MJ_PNP/QUERY_ID(HardwareIDs) ao filho
    const ioRequest = IoManager.makeIoRequest(IoManager.IRP_MJ.PNP, {
        minor: IoManager.IRP_MN.QUERY_ID, idType: 1,
    });
    IoManager.callDriver('\\Device\\' + name, ioRequest);
    if (ioRequest.status === 0 && ioRequest.info) {
        const ids = GuestStrings.readGuestWideString(ioRequest.info);
        node.data.hardwareIds = ids ? ids.split('\0').filter(s => s) : [];
    }
    return node;
}

// sobe a pilha inteira de um PDO de barramento: driver funcional, start e
// enumeracao de filhos (o ciclo PnP completo do NT)
function enumeratePdoStack(pdoNode) {
    const ids = pdoNode.data.hardwareIds ||
        (pdoNode.data.descriptor ? pdoNode.data.descriptor.hardwareIds : []);
    const driverName = ids.map(id => FUNCTION_DRIVER_BY_ID[id]).find(d => d);
    if (!driverName) {
        os.debugPrint('[pnp] sem driver p/ ' + (ids[0] || pdoNode.name));
        return null;
    }
    const fdoNode = attachFunctionDriver(pdoNode, driverName);
    if (!fdoNode) return null;
    if (startDeviceStack(fdoNode) !== 0) return fdoNode;
    // o hardware init de drivers de porta roda em WORK ITEM deferido
    // (i8042prt: IoAllocateWorkItem + IoQueueWorkItem no START) — drena a
    // fila ANTES de enumerar os filhos (como o NT ao cair de DISPATCH)
    for (let pass = 0; pass < 4; pass++) WorkItems.runQueue();
    // bus relations: o driver de barramento enumera os filhos
    const childPointers = queryBusRelations(fdoNode);
    os.debugPrint('[pnp] \\Device\\' + fdoNode.name + ': ' +
                  childPointers.length + ' filho(s) no bus');
    for (const childPointer of childPointers)
        registerChildPdo(fdoNode, childPointer);
    return fdoNode;
}

module.exports = { attachFunctionDriver, startDeviceStack, queryBusRelations,
                   registerChildPdo, enumeratePdoStack, queryHardwareIds,
                   FUNCTION_DRIVER_BY_ID };
