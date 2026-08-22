/*
 * threads.c - DPC + work item + thread de kernel (WDK real).
 * \Device\Threads devolve "threads-ok" quando os tres rodarem.
 */
#include "jsos-driver.h"

static int dpcRan, workItemRan, threadRan;
static KDPC myDpc;
static PIO_WORKITEM myWorkItem;
static PDEVICE_OBJECT myDevice;

static void myDpcRoutine(PKDPC dpc, PVOID context, PVOID sysArg1, PVOID sysArg2) {
    (void)dpc; (void)context; (void)sysArg1; (void)sysArg2;
    dpcRan = 1;
    DbgPrint("threads.sys: DPC rodou (DISPATCH_LEVEL)\r\n");
}

static void myWorkRoutine(PDEVICE_OBJECT deviceObject, PVOID context) {
    (void)deviceObject; (void)context;
    workItemRan = 1;
    DbgPrint("threads.sys: work item rodou (PASSIVE)\r\n");
    IoFreeWorkItem(myWorkItem);
}

static void myThreadRoutine(PVOID context) {
    (void)context;
    threadRan = 1;
    DbgPrint("threads.sys: thread de kernel rodou\r\n");
    PsTerminateSystemThread(STATUS_SUCCESS);
}

static NTSTATUS threadsRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp,
        (dpcRan && workItemRan && threadRan) ? "threads-ok" : "threads-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    NTSTATUS status;
    HANDLE threadHandle = NULL;
    (void)registryPath;
    DbgPrint("threads.sys: DriverEntry\r\n");

    driverObject->MajorFunction[IRP_MJ_READ] = threadsRead;
    status = JsosCreateDevice(driverObject, L"\\Device\\Threads");
    if (!NT_SUCCESS(status)) return status;
    myDevice = driverObject->DeviceObject;

    KeInitializeDpc(&myDpc, myDpcRoutine, NULL);
    KeInsertQueueDpc(&myDpc, NULL, NULL);

    myWorkItem = IoAllocateWorkItem(myDevice);
    if (myWorkItem) IoQueueWorkItem(myWorkItem, myWorkRoutine, DelayedWorkQueue, NULL);

    PsCreateSystemThread(&threadHandle, 0, NULL, NULL, NULL, myThreadRoutine, NULL);

    DbgPrint("threads.sys: DPC + work item + thread enfileirados\r\n");
    return STATUS_SUCCESS;
}
