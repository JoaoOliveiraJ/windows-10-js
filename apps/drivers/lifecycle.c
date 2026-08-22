/*
 * lifecycle.c - ciclo de vida: DriverUnload + IoDeleteSymbolicLink.
 * O selftest carrega, verifica, descarrega e confere que tudo sumiu.
 */
#include "jsos-driver.h"

static UNICODE_STRING linkName;

static void lifecycleUnload(PDRIVER_OBJECT driverObject) {
    (void)driverObject;
    DbgPrint("lifecycle.sys: DriverUnload rodando\r\n");
    IoDeleteSymbolicLink(&linkName);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    NTSTATUS status;
    (void)registryPath;
    DbgPrint("lifecycle.sys: DriverEntry\r\n");

    status = JsosCreateDevice(driverObject, L"\\Device\\LifeCycle");
    if (!NT_SUCCESS(status)) return status;

    RtlInitUnicodeString(&linkName, L"\\DosDevices\\LifeCycle");
    driverObject->DriverUnload = lifecycleUnload;

    DbgPrint("lifecycle.sys: \\Device\\LifeCycle + link criados\r\n");
    return STATUS_SUCCESS;
}
