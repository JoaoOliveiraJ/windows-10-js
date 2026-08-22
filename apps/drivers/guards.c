/*
 * guards.c - ExAllocatePool2 (WDK moderno), ObReferenceObjectByName/
 * ObfDereferenceObject com refcount real, e IRP_MJ_CLEANUP/CLOSE com
 * contadores. \Device\Guards READ devolve "guards-ok" se pool+Ob passaram.
 */
#include "jsos-driver.h"

static ULONG cleanupCount;
static ULONG createCount;
static ULONG closeCount;
static int poolPassed;
static int obPassed;

static NTSTATUS guardsCreate(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    createCount++;
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = FILE_OPENED;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS guardsCleanup(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    cleanupCount++;
    irp->IoStatus.Status = STATUS_SUCCESS;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS guardsClose(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    closeCount++;
    irp->IoStatus.Status = STATUS_SUCCESS;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS guardsRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    /* so ok depois de pool+Ob e de todo handle aberto ter sido fechado
     * (CREATE==CLEANUP==CLOSE, com pelo menos um ciclo completo) */
    int ok = poolPassed && obPassed && createCount > 0 &&
             createCount == cleanupCount && cleanupCount == closeCount;
    return JsosReadWithMessage(deviceObject, irp, ok ? "guards-ok"
                                                     : "guards-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    PVOID block, rawBlock;
    UNICODE_STRING echoName;
    PDEVICE_OBJECT echoDevice = NULL;
    (void)registryPath;
    DbgPrint("guards.sys: DriverEntry\r\n");

    /* ExAllocatePool2: pool zerado e utilizavel */
    block = ExAllocatePool2(POOL_FLAG_NON_PAGED, 128, 'gard');
    rawBlock = ExAllocatePoolUninitialized(POOL_FLAG_NON_PAGED, 64, 'gard');
    poolPassed = block != NULL && rawBlock != NULL &&
                 ((ULONG *)block)[0] == 0 && ((ULONG *)block)[31] == 0;
    if (block) {
        ((ULONG *)block)[0] = 0xC0FFEE;
        if (((ULONG *)block)[0] != 0xC0FFEE) poolPassed = 0;
    }
    if (block) ExFreePool2(block, 'gard', NULL, 0);
    if (rawBlock) ExFreePoolWithTag(rawBlock, 'gard');

    /* ObReferenceObjectByName: pega \Device\Echo com refcount, depois solta */
    RtlInitUnicodeString(&echoName, L"\\Device\\Echo");
    if (NT_SUCCESS(ObReferenceObjectByName(&echoName, OBJ_CASE_INSENSITIVE,
                                           0, NULL, KernelMode, NULL,
                                           &echoDevice)) && echoDevice) {
        LONG refs = ObfDereferenceObject(echoDevice);
        obPassed = refs >= 1;   /* tinha o create + a nossa referencia */
    }

    driverObject->MajorFunction[IRP_MJ_CREATE] = guardsCreate;
    driverObject->MajorFunction[IRP_MJ_CLEANUP] = guardsCleanup;
    driverObject->MajorFunction[IRP_MJ_CLOSE] = guardsClose;
    driverObject->MajorFunction[IRP_MJ_READ] = guardsRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Guards");
}
