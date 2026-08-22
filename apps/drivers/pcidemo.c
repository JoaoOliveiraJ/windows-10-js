/*
 * pcidemo.c - driver funcional PnP real: registra AddDevice no
 * DriverExtension; o gerenciador PnP do jsOS casa o HardwareId
 * (PCI\VEN_1234&DEV_1111, VGA) com a funcao PCI enumerada e chama
 * pcidemoAddDevice com o PDO. No START_DEVICE o driver le o
 * CM_RESOURCE_LIST (BARs do hardware) de Parameters.StartDevice.
 * \Device\PciDemo READ devolve "pcidemo-ok" se o start validou recursos.
 */
#include "jsos-driver.h"

static PDEVICE_OBJECT lowerDeviceObject;   /* PDO (bus) abaixo de nos */
static ULONG startValidated;

static NTSTATUS pcidemoRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    /* diagnostico: "pcidemo-fail:<codigo do start>" */
    char detail[20];
    detail[0]='p';detail[1]='c';detail[2]='i';detail[3]='d';detail[4]='e';
    detail[5]='m';detail[6]='o';detail[7]='-';detail[8]='f';detail[9]='a';
    detail[10]='i';detail[11]='l';detail[12]=':';
    detail[13]=(char)('0'+(startValidated&7));
    detail[14]=0;
    return JsosReadWithMessage(deviceObject, irp, startValidated == 4
                                                  ? "pcidemo-ok" : detail);
}

static NTSTATUS pcidemoPnp(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    if (stack->MinorFunction == IRP_MN_START_DEVICE) {
        PCM_RESOURCE_LIST resources =
            stack->Parameters.StartDevice.AllocatedResources;
        /* valida o CM_RESOURCE_LIST do hardware: ao menos 1 recurso de
         * memoria (BAR do framebuffer VGA) com start nao-nulo.
         * codigos de diagnostico: 1=sem lista 2=lista vazia 3=sem memoria */
        startValidated = 1;
        if (resources && resources->Count >= 1) {
            PCM_FULL_RESOURCE_DESCRIPTOR full = &resources->List[0];
            PCM_PARTIAL_RESOURCE_LIST partials = &full->PartialResourceList;
            ULONG i;
            startValidated = 3;
            for (i = 0; i < partials->Count; i++) {
                PCM_PARTIAL_RESOURCE_DESCRIPTOR descriptor =
                    &partials->PartialDescriptors[i];
                if (descriptor->Type == CmResourceTypeMemory &&
                    descriptor->u.Memory.Start.QuadPart != 0)
                    startValidated = 4;   /* 4 = ok */
            }
        } else {
            startValidated = 2;
        }
        irp->IoStatus.Status = STATUS_SUCCESS;
        IoCompleteRequest(irp, IO_NO_INCREMENT);
        return STATUS_SUCCESS;
    }
    /* outros minors: desce a pilha para o PDO */
    IoSkipCurrentIrpStackLocation(irp);
    return IoCallDriver(lowerDeviceObject, irp);
}

/* AddDevice: chamado pelo gerenciador PnP com o PDO do hardware casado */
static NTSTATUS pcidemoAddDevice(PDRIVER_OBJECT driverObject,
                                 PDEVICE_OBJECT pdo) {
    UNICODE_STRING fdoName;
    PDEVICE_OBJECT fdo = NULL;
    NTSTATUS status;
    RtlInitUnicodeString(&fdoName, L"\\Device\\PciDemo");
    status = IoCreateDevice(driverObject, 0, &fdoName, FILE_DEVICE_UNKNOWN,
                            0, FALSE, &fdo);
    if (!NT_SUCCESS(status)) return status;
    lowerDeviceObject = IoAttachDeviceToDeviceStack(fdo, pdo);
    if (!lowerDeviceObject) {
        IoDeleteDevice(fdo);
        return STATUS_NO_SUCH_DEVICE;
    }
    return STATUS_SUCCESS;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("pcidemo.sys: DriverEntry\r\n");
    driverObject->DriverExtension->AddDevice = pcidemoAddDevice;
    driverObject->MajorFunction[IRP_MJ_PNP] = pcidemoPnp;
    driverObject->MajorFunction[IRP_MJ_READ] = pcidemoRead;
    return STATUS_SUCCESS;
}
