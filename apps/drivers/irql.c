/*
 * irql.c - IRQL + spinlock: KeInitializeSpinLock / KeAcquireSpinLockRaiseToDpc
 * / KeReleaseSpinLock / KeGetCurrentIrql. \Device\Irql devolve "irql-ok".
 */
#include "jsos-driver.h"

static KSPIN_LOCK testLock;
static int allPassed;

static NTSTATUS irqlRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "irql-ok" : "irql-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    KIRQL oldIrql = HIGH_LEVEL;
    int ok = 1;
    (void)registryPath;
    DbgPrint("irql.sys: DriverEntry\r\n");

    KeInitializeSpinLock(&testLock);
    if (testLock != 0) ok = 0;
    if (KeGetCurrentIrql() != PASSIVE_LEVEL) ok = 0;

    oldIrql = KeAcquireSpinLockRaiseToDpc(&testLock);   /* retorna o IRQL antigo */
    if (oldIrql != PASSIVE_LEVEL) ok = 0;
    if (KeGetCurrentIrql() != DISPATCH_LEVEL) ok = 0;
    if (testLock != 1) ok = 0;

    KeReleaseSpinLock(&testLock, oldIrql);              /* macro -> KfReleaseSpinLock */
    if (testLock != 0) ok = 0;
    if (KeGetCurrentIrql() != PASSIVE_LEVEL) ok = 0;

    allPassed = ok;

    driverObject->MajorFunction[IRP_MJ_READ] = irqlRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Irql");
}
