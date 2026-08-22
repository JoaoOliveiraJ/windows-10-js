/*
 * irplife.c - ciclo de vida de IRP: IoAllocateIrp/IoCompleteRequest/IoFreeIrp.
 * \Device\IrpLife devolve "irp-life-ok" se o ciclo funcionou.
 */
#include "jsos-driver.h"

static int allPassed;

static NTSTATUS irplifeRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "irp-life-ok" : "irp-life-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    PIRP irp;
    (void)registryPath;
    DbgPrint("irplife.sys: DriverEntry\r\n");

    irp = IoAllocateIrp(1, FALSE);
    allPassed = 0;
    if (irp) {
        PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
        stack->MajorFunction = IRP_MJ_WRITE;
        irp->IoStatus.Status = STATUS_SUCCESS;
        IoCompleteRequest(irp, IO_NO_INCREMENT);
        /* semantica real: IoCompleteRequest preserva o status atual */
        if (irp->IoStatus.Status == STATUS_SUCCESS) allPassed = 1;
        IoFreeIrp(irp);
    }

    driverObject->MajorFunction[IRP_MJ_READ] = irplifeRead;
    return JsosCreateDevice(driverObject, L"\\Device\\IrpLife");
}
