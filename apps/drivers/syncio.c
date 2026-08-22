/*
 * syncio.c - I/O sincrono iniciado por driver (IoBuildSynchronousFsdRequest
 * + IoBuildDeviceIoControlRequest + IoCallDriver + KEVENT) atraves da pilha
 * inteira (filtro -> echo), e IoInitializeTimer/IoStartTimer (1s).
 * \Device\SyncIo READ devolve "syncio-ok" se tudo passou.
 */
#include "jsos-driver.h"

static ULONG timerTicks;
static int syncPassed;

static NTSTATUS syncIoRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    int ok = (syncPassed == 7) && timerTicks >= 1;
    return JsosReadWithMessage(deviceObject, irp, ok ? "syncio-ok"
                                                     : "syncio-fail");
}

/* IoTimerRoutine(device, context): chamada a cada ~1s enquanto ligado */
static VOID timerTickRoutine(PDEVICE_OBJECT deviceObject, PVOID context) {
    (void)deviceObject;
    (*(ULONG *)context)++;
}

static void testSynchronousIo(PDEVICE_OBJECT ownDevice) {
    KEVENT completionEvent;
    IO_STATUS_BLOCK ioStatus;
    UNICODE_STRING targetName;
    PFILE_OBJECT targetFile = NULL;
    PDEVICE_OBJECT echoDevice = NULL, filterDevice = NULL;
    PIRP irp;
    NTSTATUS status;
    char buffer[32];
    ULONG i;
    int ok = 1;

    KeInitializeEvent(&completionEvent, NotificationEvent, FALSE);

    /* WRITE sincrono no Echo (atraves do filtro, que esta no topo) */
    RtlInitUnicodeString(&targetName, L"\\Device\\Echo");
    status = IoGetDeviceObjectPointer(&targetName, FILE_ALL_ACCESS,
                                      &targetFile, &echoDevice);
    if (!NT_SUCCESS(status)) { syncPassed = 0; return; }
    buffer[0] = 's'; buffer[1] = 'y'; buffer[2] = 'n'; buffer[3] = 'c';
    irp = IoBuildSynchronousFsdRequest(IRP_MJ_WRITE, echoDevice, buffer, 4,
                                       NULL, &completionEvent, &ioStatus);
    status = IoCallDriver(echoDevice, irp);
    if (status == STATUS_PENDING)
        KeWaitForSingleObject(&completionEvent, Executive, KernelMode,
                              FALSE, NULL);
    if (ioStatus.Information == 4) syncPassed |= 1;
    IoFreeIrp(irp);

    /* READ sincrono: tem que voltar 'sync' */
    KeClearEvent(&completionEvent);
    for (i = 0; i < 4; i++) buffer[i] = 0;
    irp = IoBuildSynchronousFsdRequest(IRP_MJ_READ, echoDevice, buffer, 31,
                                       NULL, &completionEvent, &ioStatus);
    status = IoCallDriver(echoDevice, irp);
    if (status == STATUS_PENDING)
        KeWaitForSingleObject(&completionEvent, Executive, KernelMode,
                              FALSE, NULL);
    if (ioStatus.Information == 4 &&
        buffer[0] == 's' && buffer[1] == 'y' && buffer[2] == 'n' &&
        buffer[3] == 'c') syncPassed |= 2;
    IoFreeIrp(irp);

    /* IOCTL sincrono no filtro: METHOD_BUFFERED com copy-back real */
    RtlInitUnicodeString(&targetName, L"\\Device\\Filter");
    status = IoGetDeviceObjectPointer(&targetName, FILE_ALL_ACCESS,
                                      &targetFile, &filterDevice);
    if (!NT_SUCCESS(status)) { syncPassed = 0; return; }
    KeClearEvent(&completionEvent);
    for (i = 0; i < 9; i++) buffer[i] = 0;
    irp = IoBuildDeviceIoControlRequest(0x801, filterDevice, NULL, 0,
                                        buffer, 31, FALSE, &completionEvent,
                                        &ioStatus);
    status = IoCallDriver(filterDevice, irp);
    if (status == STATUS_PENDING)
        KeWaitForSingleObject(&completionEvent, Executive, KernelMode,
                              FALSE, NULL);
    if (ioStatus.Information >= 9 &&
        buffer[0] == 'f' && buffer[1] == 'i' && buffer[2] == 'l' &&
        buffer[3] == 't' && buffer[4] == 'e' && buffer[5] == 'r' &&
        buffer[6] == '-' && buffer[7] == 'o' && buffer[8] == 'k')
        syncPassed |= 4;
    IoFreeIrp(irp);

    (void)ok;

    /* Io timer do proprio device: 1 chamada por segundo */
    IoInitializeTimer(ownDevice, timerTickRoutine, &timerTicks);
    IoStartTimer(ownDevice);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    NTSTATUS status;
    (void)registryPath;
    DbgPrint("syncio.sys: DriverEntry\r\n");

    status = JsosCreateDevice(driverObject, L"\\Device\\SyncIo");
    if (!NT_SUCCESS(status)) return status;
    timerTicks = 0;
    testSynchronousIo(driverObject->DeviceObject);

    driverObject->MajorFunction[IRP_MJ_READ] = syncIoRead;
    return STATUS_SUCCESS;
}
