/*
 * expool.c - ExAllocatePoolWithTag / ExFreePool com free real + IoDeleteDevice.
 * \Device\ExPool devolve "ex-pool-ok"; \Device\ExPoolTrash some do namespace.
 */
#include "jsos-driver.h"

static int allPassed;

static NTSTATUS expoolRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "ex-pool-ok" : "ex-pool-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    PVOID block, trashDevice = NULL;
    ULONG i;
    int ok = 1;
    (void)registryPath;
    DbgPrint("expool.sys: DriverEntry\r\n");

    block = ExAllocatePoolWithTag(NonPagedPool, 4096, 'SOSJ');   /* 'JSOS' LE */
    if (block) {
        unsigned char *bytes = (unsigned char *)block;
        for (i = 0; i < 4096; i++) bytes[i] = 0xA7;
        for (i = 0; i < 4096; i++) if (bytes[i] != 0xA7) { ok = 0; break; }
        ExFreePool(block);
    } else {
        ok = 0;
    }
    allPassed = ok;

    driverObject->MajorFunction[IRP_MJ_READ] = expoolRead;

    /* device descartavel criado e removido (IoDeleteDevice real) */
    if (JsosCreateDevice(driverObject, L"\\Device\\ExPoolTrash") == STATUS_SUCCESS) {
        /* acha o PDEVICE_OBJECT pela lista do driver e remove */
        PDEVICE_OBJECT trash = driverObject->DeviceObject;
        if (trash) IoDeleteDevice(trash);
    }

    return JsosCreateDevice(driverObject, L"\\Device\\ExPool");
}
