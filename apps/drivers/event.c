/*
 * event.c - objetos do dispatcher NT: KEVENT (notification/sync), KMUTEX e
 * KeWaitForSingleObject/MultipleObjects. Cenario real: uma thread de kernel
 * espera num evento que um DPC de timer sinaliza; o READ devolve
 * "event-ok" se tudo passou (wake por evento, mutex, auto-reset, timeout,
 * WaitAny).
 */
#include "jsos-driver.h"

static KEVENT dataReadyEvent;       /* notification: DPC -> thread */
static KEVENT syncEvent;            /* synchronization (auto-reset) */
static KEVENT neverSignaledEvent;
static KMUTEX guardMutex;
static KTIMER producerTimer;
static KDPC producerDpc;
static ULONG workerDone;
static ULONG allPassed;

static VOID producerDpcRoutine(PKDPC dpc, PVOID context, PVOID arg1, PVOID arg2) {
    (void)dpc; (void)context; (void)arg1; (void)arg2;
    KeSetEvent(&dataReadyEvent, IO_NO_INCREMENT, FALSE);
}

static VOID workerThread(PVOID context) {
    NTSTATUS status;
    PVOID waitArray[2];
    (void)context;

    /* bloqueia de verdade ate o DPC do timer sinalizar o evento */
    status = KeWaitForSingleObject(&dataReadyEvent, Executive, KernelMode,
                                   FALSE, NULL);
    if (status != STATUS_SUCCESS) return;

    /* WaitAny em (evento sinalizado, evento vazio) -> indice 0 */
    waitArray[0] = &dataReadyEvent;
    waitArray[1] = &neverSignaledEvent;
    if (KeWaitForMultipleObjects(2, waitArray, WaitAny, Executive, KernelMode,
                                 FALSE, NULL, NULL) != 0) return;

    /* mutex: adquire, segura, libera */
    if (KeWaitForSingleObject(&guardMutex, Executive, KernelMode, FALSE,
                              NULL) != STATUS_SUCCESS) return;
    workerDone = 1;
    KeReleaseMutex(&guardMutex, FALSE);
    PsTerminateSystemThread(STATUS_SUCCESS);
}

static NTSTATUS eventRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp,
                               (allPassed && workerDone) ? "event-ok"
                                                         : "event-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    LARGE_INTEGER due15ms, timeout1ms;
    NTSTATUS status;
    int ok = 1;
    (void)registryPath;
    DbgPrint("event.sys: DriverEntry\r\n");

    KeInitializeEvent(&dataReadyEvent, NotificationEvent, FALSE);
    KeInitializeEvent(&syncEvent, SynchronizationEvent, TRUE);
    KeInitializeEvent(&neverSignaledEvent, NotificationEvent, FALSE);
    KeInitializeMutex(&guardMutex, 0);

    /* auto-reset: syncEvent comeca sinalizado; o wait consome e reseta */
    if (KeWaitForSingleObject(&syncEvent, Executive, KernelMode, FALSE,
                              NULL) != STATUS_SUCCESS) ok = 0;
    if (KeReadStateEvent(&syncEvent) != 0) ok = 0;

    /* timeout: evento nunca sinalizado + 1ms -> STATUS_TIMEOUT */
    timeout1ms.QuadPart = -(1 * 10000);
    if (KeWaitForSingleObject(&neverSignaledEvent, Executive, KernelMode,
                              FALSE, &timeout1ms) != STATUS_TIMEOUT) ok = 0;

    /* thread esperando o evento; timer de 15ms sinaliza via DPC */
    KeInitializeTimer(&producerTimer);
    KeInitializeDpc(&producerDpc, producerDpcRoutine, NULL);
    {
        static HANDLE workerHandle;
        status = PsCreateSystemThread(&workerHandle, 0, NULL, NULL, NULL,
                                      workerThread, NULL);
    }
    if (!NT_SUCCESS(status)) ok = 0;
    due15ms.QuadPart = -(15 * 10000);
    KeSetTimer(&producerTimer, due15ms, &producerDpc);

    allPassed = ok;
    driverObject->MajorFunction[IRP_MJ_READ] = eventRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Event");
}
