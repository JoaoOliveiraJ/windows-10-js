/*
 * locks.c - ERESOURCE (reader/writer real), rundown protection e RTL de
 * memoria. \Device\Locks READ devolve "locks-ok" se tudo passou.
 */
#include "jsos-driver.h"

static ERESOURCE testResource;
static EX_RUNDOWN_REF rundown;
static ULONG allPassed;

static NTSTATUS locksRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "locks-ok"
                                                            : "locks-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    char areaA[32], areaB[32];
    ULONG i;
    int ok = 1;
    (void)registryPath;
    DbgPrint("locks.sys: DriverEntry\r\n");

    /* ERESOURCE: exclusivo dentro, dois shared dentro, convert, release */
    ExInitializeResourceLite(&testResource);
    if (!ExAcquireResourceExclusiveLite(&testResource, TRUE)) ok = 0;
    if (!ExIsResourceAcquiredExclusiveLite(&testResource)) ok = 0;
    if (ExAcquireResourceSharedLite(&testResource, FALSE) != 0) ok = 0; /* sem wait: falha */
    ExConvertExclusiveToSharedLite(&testResource);
    if (ExIsResourceAcquiredExclusiveLite(&testResource)) ok = 0;
    if (!ExAcquireResourceSharedLite(&testResource, FALSE)) ok = 0;     /* vira 2o leitor */
    if (ExIsResourceAcquiredSharedLite(&testResource) != 2) ok = 0;
    ExReleaseResourceLite(&testResource);
    ExReleaseResourceLite(&testResource);
    if (ExIsResourceAcquiredSharedLite(&testResource) != 0) ok = 0;
    ExDeleteResourceLite(&testResource);

    /* rundown: adquire, libera, completa -> novas aquisicoes falham */
    ExInitializeRundownProtection(&rundown);
    if (!ExAcquireRundownProtection(&rundown)) ok = 0;
    ExReleaseRundownProtection(&rundown);
    ExRundownCompleted(&rundown);
    if (ExAcquireRundownProtection(&rundown)) ok = 0;   /* tem que falhar */

    /* RTL de memoria: fill/zero/copy/move/compare */
    RtlFillMemory(areaA, 16, 0xAB);
    for (i = 0; i < 16; i++) if ((unsigned char)areaA[i] != 0xAB) ok = 0;
    RtlZeroMemory(areaA, 16);
    for (i = 0; i < 16; i++) if (areaA[i] != 0) ok = 0;
    for (i = 0; i < 16; i++) areaA[i] = (char)i;
    RtlCopyMemory(areaB, areaA, 16);
    if (RtlCompareMemory(areaA, areaB, 16) != 16) ok = 0;
    RtlMoveMemory(areaA + 4, areaA, 12);   /* sobreposicao real */
    if (RtlCompareMemory(areaA + 4, areaB, 12) != 12) ok = 0;

    allPassed = ok;
    driverObject->MajorFunction[IRP_MJ_READ] = locksRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Locks");
}
