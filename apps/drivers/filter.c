/*
 * filter.c - filtro WDM real acima do \Device\Echo: anexa na pilha com
 * IoGetDeviceObjectPointer + IoAttachDeviceToDeviceStack, repassa READ/WRITE
 * com IoCopyCurrentIrpStackLocationToNext + IoSetCompletionRoutine +
 * IoCallDriver, PNP/POWER com IoSkipCurrentIrpStackLocation, e atende um
 * IOCTL proprio (0x801) com estatisticas. \Device\Filter.
 */
#include "jsos-driver.h"

#define IOCTL_FILTER_STATS 0x801

static PDEVICE_OBJECT filterDeviceObject;   /* \Device\Filter (nosso) */
static PDEVICE_OBJECT callTargetDevice;     /* device abaixo na pilha */
static ULONG irpsSeen;
static ULONG completionsSeen;

static NTSTATUS filterCompletionRoutine(PDEVICE_OBJECT deviceObject, PIRP irp,
                                        PVOID context) {
    (void)deviceObject; (void)irp; (void)context;
    completionsSeen++;
    return STATUS_SUCCESS;
}

/* READ/WRITE: copia o slot, registra completion e desce (padrao de filtro) */
static NTSTATUS filterPassThrough(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    irpsSeen++;
    IoCopyCurrentIrpStackLocationToNext(irp);
    IoSetCompletionRoutine(irp, filterCompletionRoutine, NULL, TRUE, TRUE, TRUE);
    return IoCallDriver(callTargetDevice, irp);
}

/* PNP/POWER: nem toca o slot (o driver de baixo ve o slot identico) */
static NTSTATUS filterForwardDown(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    irpsSeen++;
    IoSkipCurrentIrpStackLocation(irp);
    return IoCallDriver(callTargetDevice, irp);
}

static NTSTATUS filterControl(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    ULONG code = stack->Parameters.DeviceIoControl.IoControlCode;
    if (code == IOCTL_FILTER_STATS) {
        /* "filter-ok:<vistos>,<completados>" (digitos simples) */
        char message[20];
        ULONG length = 0, i, n;
        message[0]='f';message[1]='i';message[2]='l';message[3]='t';
        message[4]='e';message[5]='r';message[6]='-';message[7]='o';
        message[8]='k';message[9]=':';
        message[10]=(char)('0'+(irpsSeen>9?9:irpsSeen));
        message[11]=',';
        message[12]=(char)('0'+(completionsSeen>9?9:completionsSeen));
        message[13]=0;
        while (message[length]) length++;
        n = stack->Parameters.DeviceIoControl.OutputBufferLength < length
            ? stack->Parameters.DeviceIoControl.OutputBufferLength : length;
        for (i = 0; i < n; i++)
            ((char *)irp->AssociatedIrp.SystemBuffer)[i] = message[i];
        irp->IoStatus.Status = STATUS_SUCCESS;
        irp->IoStatus.Information = n;
        IoCompleteRequest(irp, IO_NO_INCREMENT);
        return STATUS_SUCCESS;
    }
    return filterForwardDown(deviceObject, irp);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    UNICODE_STRING echoName;
    PFILE_OBJECT echoFileObject = NULL;
    PDEVICE_OBJECT echoDevice = NULL;
    NTSTATUS status;
    ULONG majorIndex;
    (void)registryPath;
    DbgPrint("filter.sys: DriverEntry\r\n");

    status = JsosCreateDevice(driverObject, L"\\Device\\Filter");
    if (!NT_SUCCESS(status)) return status;
    filterDeviceObject = driverObject->DeviceObject;

    /* resolve o alvo e anexa no topo da pilha do Echo */
    RtlInitUnicodeString(&echoName, L"\\Device\\Echo");
    status = IoGetDeviceObjectPointer(&echoName, FILE_READ_DATA,
                                      &echoFileObject, &echoDevice);
    if (!NT_SUCCESS(status)) return status;
    callTargetDevice = IoAttachDeviceToDeviceStack(filterDeviceObject,
                                                   echoDevice);
    if (!callTargetDevice) return STATUS_NO_SUCH_DEVICE;

    /* padrao WDM real: TUDO desce a pilha por padrao; so READ/WRITE ganham
     * completion e DEVICE_CONTROL atende o IOCTL de stats localmente */
    for (majorIndex = 0; majorIndex <= IRP_MJ_MAXIMUM_FUNCTION; majorIndex++)
        driverObject->MajorFunction[majorIndex] = filterForwardDown;
    driverObject->MajorFunction[IRP_MJ_READ] = filterPassThrough;
    driverObject->MajorFunction[IRP_MJ_WRITE] = filterPassThrough;
    driverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL] = filterControl;
    return STATUS_SUCCESS;
}
