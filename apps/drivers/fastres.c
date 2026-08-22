/*
 * fastres.c - FAST_MUTEX real (ExInitialize/Acquire/TryToAcquire/Release,
 * com contencao em KEVENT), RtlIntegerToUnicodeString/RtlUnicodeStringToInteger
 * e IoQueueWorkItemEx (3 args). \Device\FastRes READ devolve "fastres-ok".
 */
#include "jsos-driver.h"

static FAST_MUTEX testMutex;
static ULONG workItemExRan;
static ULONG allPassed;
static PIO_WORKITEM storedWorkItem;

static VOID workItemExRoutine(PVOID ioObject, PVOID context, PVOID ioWorkItem) {
    (void)ioObject;
    if (ioWorkItem != NULL) *(ULONG *)context = 1;   /* 3o arg chegou */
}

static NTSTATUS fastresRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    int ok = allPassed && workItemExRan;
    if (storedWorkItem && workItemExRan) {   /* ja drenou: libera de verdade */
        IoFreeWorkItem(storedWorkItem);
        storedWorkItem = NULL;
    }
    return JsosReadWithMessage(deviceObject, irp, ok ? "fastres-ok"
                                                     : "fastres-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    WCHAR wideBuffer[32];
    UNICODE_STRING text;
    ULONG value = 0;
    int ok = 1;
    (void)registryPath;
    DbgPrint("fastres.sys: DriverEntry\r\n");

    /* FAST_MUTEX: acquire -> try falha -> release -> try sucede -> release */
    ExInitializeFastMutex(&testMutex);
    ExAcquireFastMutex(&testMutex);
    if (testMutex.Count != 0) ok = 0;
    if (ExTryToAcquireFastMutex(&testMutex) != 0) ok = 0;   /* tem que falhar */
    ExReleaseFastMutex(&testMutex);
    if (testMutex.Count != 1) ok = 0;
    if (ExTryToAcquireFastMutex(&testMutex) != 1) ok = 0;   /* agora tem que ir */
    ExReleaseFastMutex(&testMutex);

    /* Rtl int <-> string: 31337 decimal e hex */
    text.Buffer = wideBuffer;
    text.Length = 0;
    text.MaximumLength = sizeof(wideBuffer);
    if (RtlIntegerToUnicodeString(31337, 10, &text) != STATUS_SUCCESS) ok = 0;
    else {
        if (RtlUnicodeStringToInteger(&text, 10, &value) != STATUS_SUCCESS ||
            value != 31337) ok = 0;
    }
    text.Length = 0;
    if (RtlIntegerToUnicodeString(0xC0FFEE, 16, &text) != STATUS_SUCCESS) ok = 0;
    else {
        if (RtlUnicodeStringToInteger(&text, 16, &value) != STATUS_SUCCESS ||
            value != 0xC0FFEE) ok = 0;
    }

    /* work item EX: routine com (ioObject, context, ioWorkItem) */
    storedWorkItem = IoAllocateWorkItem(driverObject->DeviceObject);
    if (!storedWorkItem) ok = 0;
    else {
        IoQueueWorkItemEx(storedWorkItem, workItemExRoutine, CriticalWorkQueue,
                          &workItemExRan);
    }

    allPassed = ok;
    driverObject->MajorFunction[IRP_MJ_READ] = fastresRead;
    return JsosCreateDevice(driverObject, L"\\Device\\FastRes");
}
