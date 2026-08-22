/*
 * echo.c - driver demo do jsOS com o WDK real (ntddk.h), compilado com
 * MSVC (cl.exe) no build. \Device\Echo: WRITE guarda texto, READ devolve.
 * IRP_MJ_PNP/START_DEVICE marca o dispositivo como iniciado.
 */
#include "jsos-driver.h"

static char lastText[256];
static ULONG lastLength;
static int pnpStarted;

static NTSTATUS echoRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    /* devolve exatamente lastLength bytes (a string NAO e terminada em NUL) */
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    ULONG i;
    ULONG n = stack->Parameters.Read.Length < lastLength
              ? stack->Parameters.Read.Length : lastLength;
    (void)deviceObject;
    for (i = 0; i < n; i++)
        ((char *)irp->AssociatedIrp.SystemBuffer)[i] = lastText[i];
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = n;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}
static NTSTATUS echoWrite(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosWriteToStorage(deviceObject, irp, lastText, &lastLength);
}
static NTSTATUS echoPnp(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    (void)deviceObject;
    if (stack->MinorFunction == IRP_MN_START_DEVICE) {
        pnpStarted = 1;
        DbgPrint("echo.sys: PNP START_DEVICE\r\n");
    }
    irp->IoStatus.Status = STATUS_SUCCESS;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("echo.sys: DriverEntry (WDK real, compilado com MSVC)\r\n");
    driverObject->MajorFunction[IRP_MJ_READ]  = echoRead;
    driverObject->MajorFunction[IRP_MJ_WRITE] = echoWrite;
    driverObject->MajorFunction[IRP_MJ_PNP]   = echoPnp;
    return JsosCreateDevice(driverObject, L"\\Device\\Echo");
}
