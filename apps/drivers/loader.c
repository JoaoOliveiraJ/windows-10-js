/*
 * loader.c - ZwLoadDriver/ZwUnloadDriver reais (via Registry), PsLookupProcess
 * ByProcessId + PsGetProcessId (offset RE 0x440), ExAcquireSpinLock,
 * IoGetStackLimits e ZwQuerySystemInformation(SystemProcessInformation).
 * \Device\Loader READ devolve "loader-ok".
 * Bits: 1=lookup/pid 2=spinlock 4=stacklimits 8=zwloaddriver 16=querySysInfo
 */
#include "jsos-driver.h"

static ULONG allPassed;

static NTSTATUS loaderRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    char detail[22];
    detail[0]='l';detail[1]='o';detail[2]='a';detail[3]='d';detail[4]='e';
    detail[5]='r';detail[6]='-';detail[7]='f';detail[8]='a';detail[9]='i';
    detail[10]='l';detail[11]=':';
    detail[12]="0123456789abcdef"[(allPassed >> 4) & 0xF];
    detail[13]="0123456789abcdef"[allPassed & 0xF];
    detail[14]=0;
    return JsosReadWithMessage(deviceObject, irp,
                               allPassed == 0x1F ? "loader-ok" : detail);
}

static void testProcessLookup(void) {
    PVOID systemProcess = NULL;
    if (NT_SUCCESS(PsLookupProcessByProcessId((HANDLE)4, &systemProcess)) &&
        systemProcess &&
        PsGetProcessId(systemProcess) == (HANDLE)4)
        allPassed |= 1;
}

static void testSpinLockAndStack(void) {
    KIRQL oldIrql;
    ULONG_PTR lowLimit = 0, highLimit = 0;
    static KSPIN_LOCK legacyLock;
    KeInitializeSpinLock(&legacyLock);
    ExAcquireSpinLock(&legacyLock, &oldIrql);
    if (*((ULONG *)&legacyLock) != 1) return;
    ExReleaseSpinLock(&legacyLock, oldIrql);
    if (*((ULONG *)&legacyLock) != 0) return;
    allPassed |= 2;

    IoGetStackLimits(&lowLimit, &highLimit);
    if (lowLimit == 0x200000 && highLimit > lowLimit) allPassed |= 4;
}

static void testLoadUnloadDriver(void) {
    UNICODE_STRING servicePath;
    OBJECT_ATTRIBUTES attributes;
    IO_STATUS_BLOCK ioStatus;
    UNICODE_STRING deviceName;
    HANDLE deviceHandle = NULL;

    /* carrega o servico 'ondemand' (lifecycle.sys) — de verdade */
    RtlInitUnicodeString(&servicePath,
                         L"\\Registry\\Machine\\System\\Services\\ondemand");
    if (!NT_SUCCESS(ZwLoadDriver(&servicePath))) return;

    /* o device do driver carregado existe? abre de verdade */
    RtlInitUnicodeString(&deviceName, L"\\Device\\LifeCycle");
    InitializeObjectAttributes(&attributes, &deviceName, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (!NT_SUCCESS(ZwOpenFile(&deviceHandle, GENERIC_READ, &attributes,
                               &ioStatus, 0, 0)))
        return;
    ZwClose(deviceHandle);

    /* descarrega; a abertura tem que falhar depois */
    if (!NT_SUCCESS(ZwUnloadDriver(&servicePath))) return;
    if (NT_SUCCESS(ZwOpenFile(&deviceHandle, GENERIC_READ, &attributes,
                              &ioStatus, 0, 0))) {
        ZwClose(deviceHandle);
        return;   /* nao deveria existir mais */
    }
    allPassed |= 8;
}

static void testQuerySystemInformation(void) {
    static UCHAR infoBuffer[4096];
    ULONG returnLength = 0;
    NTSTATUS status;
    ULONG offset = 0, entryCount = 0;
    int sawSystem = 0;

    status = ZwQuerySystemInformation(5 /* SystemProcessInformation */,
                                      infoBuffer, sizeof(infoBuffer),
                                      &returnLength);
    if (!NT_SUCCESS(status) || returnLength == 0) return;
    for (;;) {
        ULONG nextOffset = *(ULONG *)(infoBuffer + offset);
        ULONG64 pid = *(ULONG64 *)(infoBuffer + offset + 0x50);
        if (pid == 4) sawSystem = 1;
        entryCount++;
        if (!nextOffset) break;
        offset += nextOffset;
        if (offset > returnLength) break;
    }
    if (sawSystem && entryCount >= 2) allPassed |= 16;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("loader.sys: DriverEntry\r\n");
    allPassed = 0;
    testProcessLookup();
    testSpinLockAndStack();
    testLoadUnloadDriver();
    testQuerySystemInformation();
    driverObject->MajorFunction[IRP_MJ_READ] = loaderRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Loader");
}
