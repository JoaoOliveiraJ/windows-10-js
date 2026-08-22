/*
 * openx.c - IoCreateFile (14 args) abrindo \Device\Echo por nome com CREATE
 * IRP real, ZwWriteFile/ZwReadFile NO DISPOSITIVO (IRPs de verdade),
 * DbgPrintEx com formato e ExInitializeWorkItem/ExQueueWorkItem.
 * \Device\OpenX READ devolve "openx-ok".
 */
#include "jsos-driver.h"

static ULONG allPassed;
static ULONG exWorkItemRan;

/* WORKER de 1 argumento (modelo Ex) */
static VOID exWorkerRoutine(PVOID context) {
    *(ULONG *)context = 1;
}

static NTSTATUS openxRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    int ok = allPassed && exWorkItemRan;
    return JsosReadWithMessage(deviceObject, irp, ok ? "openx-ok"
                                                     : "openx-fail");
}

static void testDeviceOpenByName(void) {
    OBJECT_ATTRIBUTES attributes;
    UNICODE_STRING echoName;
    IO_STATUS_BLOCK ioStatus;
    HANDLE echoHandle = NULL;
    LARGE_INTEGER offset;
    static const char payload[4] = { 'w', '4', '2', '!' };
    char readBack[4];
    NTSTATUS status;

    RtlInitUnicodeString(&echoName, L"\\Device\\Echo");
    InitializeObjectAttributes(&attributes, &echoName, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    status = IoCreateFile(&echoHandle, GENERIC_READ | GENERIC_WRITE,
                          &attributes, &ioStatus, NULL,
                          FILE_ATTRIBUTE_NORMAL, 0, FILE_OPEN,
                          FILE_NON_DIRECTORY_FILE, NULL, 0, 0, NULL, 0);
    if (!NT_SUCCESS(status)) return;

    /* WRITE no dispositivo por handle (IRP_MJ_WRITE real) */
    offset.QuadPart = 0;
    status = ZwWriteFile(echoHandle, NULL, NULL, NULL, &ioStatus,
                         (void *)payload, 4, &offset, NULL);
    if (!NT_SUCCESS(status) || ioStatus.Information != 4) {
        ZwClose(echoHandle);
        return;
    }

    /* READ de volta: tem que vir o payload */
    readBack[0] = readBack[1] = readBack[2] = readBack[3] = 0;
    offset.QuadPart = 0;
    status = ZwReadFile(echoHandle, NULL, NULL, NULL, &ioStatus,
                        readBack, 4, &offset, NULL);
    ZwClose(echoHandle);
    if (NT_SUCCESS(status) && ioStatus.Information == 4 &&
        readBack[0] == 'w' && readBack[1] == '4' &&
        readBack[2] == '2' && readBack[3] == '!')
        allPassed = 1;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    static WORK_QUEUE_ITEM exWorkItem;
    (void)registryPath;
    DbgPrintEx(101 /* DPFLTR_DEFAULT_ID (dpfilter.h) */, DPFLTR_ERROR_LEVEL,
               "openx.sys: DriverEntry (formato %s: %d = 0x%x)\r\n",
               "real", 42, 42);

    exWorkItemRan = 0;
    ExInitializeWorkItem(&exWorkItem, exWorkerRoutine, &exWorkItemRan);
    ExQueueWorkItem(&exWorkItem, CriticalWorkQueue);

    testDeviceOpenByName();
    driverObject->MajorFunction[IRP_MJ_READ] = openxRead;
    return JsosCreateDevice(driverObject, L"\\Device\\OpenX");
}
