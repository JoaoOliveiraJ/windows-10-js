/*
 * power.c - Power Manager: IRP_MJ_POWER (QUERY/SET_POWER) com DeviceExtension,
 * PoSetPowerState (retorna o estado ANTERIOR, conferido), PoStartNextPowerIrp
 * e PoCallDriver. \Device\Power devolve "power-D<n>" com o estado corrente.
 */
#include "jsos-driver.h"

typedef struct {
    DEVICE_POWER_STATE CurrentState;
    ULONG SetCount;
    ULONG QueryCount;
    ULONG PoStateConsistent;   /* PoSetPowerState bateu com o estado rastreado */
} POWER_DEVICE_EXTENSION;

static NTSTATUS powerRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    POWER_DEVICE_EXTENSION *extension = deviceObject->DeviceExtension;
    char message[12];
    ULONG length = 0, i, n;
    message[0] = 'p'; message[1] = 'o'; message[2] = 'w'; message[3] = 'e';
    message[4] = 'r'; message[5] = '-'; message[6] = 'D';
    message[7] = (char)('0' + (extension->CurrentState - PowerDeviceD0));
    message[8] = 0;
    if (!extension->PoStateConsistent) {
        message[6] = 'X';   /* "power-DX" sinaliza inconsistencia do Po */
    }
    while (message[length]) length++;
    n = stack->Parameters.Read.Length < length ? stack->Parameters.Read.Length
                                               : length;
    for (i = 0; i < n; i++)
        ((char *)irp->AssociatedIrp.SystemBuffer)[i] = message[i];
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = n;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS powerDispatch(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    POWER_DEVICE_EXTENSION *extension = deviceObject->DeviceExtension;
    NTSTATUS status = STATUS_SUCCESS;

    switch (stack->MinorFunction) {
    case IRP_MN_SET_POWER: {
        POWER_STATE previousState;
        if (stack->Parameters.Power.Type != DevicePowerState) {
            status = STATUS_INVALID_PARAMETER;
            break;
        }
        /* notifica o Power Manager; o retorno DEVE ser o estado anterior */
        previousState = PoSetPowerState(deviceObject, DevicePowerState,
                                        stack->Parameters.Power.State);
        if (previousState.DeviceState != extension->CurrentState)
            extension->PoStateConsistent = 0;
        extension->CurrentState = stack->Parameters.Power.State.DeviceState;
        extension->SetCount++;
        break;
    }
    case IRP_MN_QUERY_POWER:
        extension->QueryCount++;
        break;
    default:
        status = STATUS_NOT_SUPPORTED;
        break;
    }

    PoStartNextPowerIrp(irp);
    irp->IoStatus.Status = status;
    irp->IoStatus.Information = 0;
    PoCallDriver(deviceObject, irp);
    return status;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    UNICODE_STRING deviceName, linkName;
    PDEVICE_OBJECT deviceObject = NULL;
    NTSTATUS status;
    POWER_DEVICE_EXTENSION *extension;
    (void)registryPath;
    DbgPrint("power.sys: DriverEntry\r\n");

    RtlInitUnicodeString(&deviceName, L"\\Device\\Power");
    status = IoCreateDevice(driverObject, sizeof(POWER_DEVICE_EXTENSION),
                            &deviceName, FILE_DEVICE_UNKNOWN, 0, FALSE,
                            &deviceObject);
    if (!NT_SUCCESS(status)) return status;
    extension = deviceObject->DeviceExtension;
    extension->CurrentState = PowerDeviceD0;   /* devices comecam ligados */
    extension->PoStateConsistent = 1;

    RtlInitUnicodeString(&linkName, L"\\DosDevices\\Power");
    IoCreateSymbolicLink(&linkName, &deviceName);

    driverObject->MajorFunction[IRP_MJ_READ] = powerRead;
    driverObject->MajorFunction[IRP_MJ_POWER] = powerDispatch;
    return STATUS_SUCCESS;
}
