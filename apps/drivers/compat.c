/*
 * compat.c - Rtl upcase/prefix/append, MmGetPhysicalAddress (paginacao de
 * verdade), KeSetImportanceDpc/KeSetTargetProcessorDpc/KeFlushQueuedDpcs e
 * ZwQueryFullAttributesFile. \Device\Compat READ devolve "compat-ok".
 */
#include "jsos-driver.h"

static ULONG allPassed;
static KDPC flushDpc;
static ULONG dpcRan;

static VOID flushDpcRoutine(PKDPC dpc, PVOID context, PVOID arg1, PVOID arg2) {
    (void)dpc; (void)arg1; (void)arg2;
    *(ULONG *)context = 1;
}

static NTSTATUS compatRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "compat-ok"
                                                            : "compat-fail");
}

static void testRtlStrings(void) {
    UNICODE_STRING source, upper, expected, prefix, joined;
    WCHAR joinedBuffer[32];
    RtlInitUnicodeString(&source, L"Kernel");
    RtlInitUnicodeString(&expected, L"KERNEL");
    if (!NT_SUCCESS(RtlUpcaseUnicodeString(&upper, &source, TRUE))) return;
    if (!RtlEqualUnicodeString(&upper, &expected, FALSE)) {
        RtlFreeUnicodeString(&upper);
        return;
    }
    RtlFreeUnicodeString(&upper);
    RtlInitUnicodeString(&prefix, L"Kern");
    if (!RtlPrefixUnicodeString(&prefix, &source, TRUE)) return;

    joined.Buffer = joinedBuffer;
    joined.Length = 0;
    joined.MaximumLength = sizeof(joinedBuffer);
    if (!NT_SUCCESS(RtlAppendUnicodeToString(&joined, L"Ker"))) return;
    if (!NT_SUCCESS(RtlAppendUnicodeToString(&joined, L"nel-NT"))) return;
    RtlInitUnicodeString(&expected, L"Kernel-NT");
    if (!RtlEqualUnicodeString(&joined, &expected, FALSE)) return;
    allPassed |= 1;
}

static void testPhysicalAddress(void) {
    PHYSICAL_ADDRESS physical = MmGetPhysicalAddress(&allPassed);
    /* nosso espaco e' identity-mapped: a traducao pela tabela devolve o mesmo */
    if (physical.QuadPart == (ULONG_PTR)&allPassed) allPassed |= 2;
}

static void testDpcControls(void) {
    KeInitializeDpc(&flushDpc, flushDpcRoutine, &dpcRan);
    KeSetImportanceDpc(&flushDpc, HighImportance);
    KeSetTargetProcessorDpc(&flushDpc, 0);
    if (flushDpc.Importance != HighImportance) return;
    KeInsertQueueDpc(&flushDpc, NULL, NULL);
    KeFlushQueuedDpcs();          /* drena na hora — o DPC roda sincrono */
    if (dpcRan) allPassed |= 4;
}

static void testQueryAttributes(void) {
    OBJECT_ATTRIBUTES attributes;
    UNICODE_STRING path;
    FILE_BASIC_INFORMATION information;
    RtlInitUnicodeString(&path, L"\\DosDevices\\D:\\HELLO.TXT");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (!NT_SUCCESS(ZwQueryFullAttributesFile(&attributes, &information)))
        return;
    if (information.FileAttributes == FILE_ATTRIBUTE_NORMAL)
        allPassed |= 8;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("compat.sys: DriverEntry\r\n");
    allPassed = 0;
    dpcRan = 0;
    testRtlStrings();
    testPhysicalAddress();
    testDpcControls();
    testQueryAttributes();
    driverObject->MajorFunction[IRP_MJ_READ] = compatRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Compat");
}
