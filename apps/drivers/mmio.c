/*
 * mmio.c - MmMapIoSpace/UnmapIoSpace (LAPIC real lido via mapeamento),
 * ZwEnumerateKey/ZwEnumerateValueKey/ZwDeleteKey no Registry e
 * KeStallExecutionProcessor medido com KeQueryPerformanceCounter (TSC).
 * \Device\Mmio READ devolve "mmio-ok" se tudo passou.
 */
#include "jsos-driver.h"

static ULONG allPassed;

static NTSTATUS mmioRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "mmio-ok"
                                                            : "mmio-fail");
}

static void testMmioLapic(void) {
    volatile ULONG *lapic;
    ULONG apicId;
    PHYSICAL_ADDRESS lapicPhysical;
    lapicPhysical.QuadPart = 0xFEE00000;
    lapic = MmMapIoSpace(lapicPhysical, 0x1000, MmNonCached);
    if (!lapic) return;
    apicId = (lapic[0x20 / 4] >> 24) & 0xFF;   /* LAPIC ID do BSP = 0 */
    MmUnmapIoSpace((PVOID)lapic, 0x1000);
    if (apicId == 0) allPassed |= 1;
}

static void testRegistryEnum(void) {
    OBJECT_ATTRIBUTES attributes;
    UNICODE_STRING path;
    HANDLE servicesKey = NULL, echoKey = NULL, testKey = NULL, reopened = NULL;
    char buffer[256];
    ULONG length, index, serviceCount = 0;
    NTSTATUS status;

    RtlInitUnicodeString(&path, L"\\Registry\\Machine\\System\\Services");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (!NT_SUCCESS(ZwOpenKey(&servicesKey, KEY_ENUMERATE_SUB_KEYS,
                              &attributes))) return;
    for (index = 0;; index++) {
        status = ZwEnumerateKey(servicesKey, index, KeyBasicInformation,
                                buffer, sizeof(buffer), &length);
        if (status == STATUS_NO_MORE_ENTRIES) break;
        if (!NT_SUCCESS(status)) { ZwClose(servicesKey); return; }
        serviceCount++;
    }
    ZwClose(servicesKey);
    if (serviceCount < 10) return;   /* hive semeada tem 11 servicos */

    /* enumera valores do servico echo: indice 0 = "DriverFile" */
    RtlInitUnicodeString(&path, L"\\Registry\\Machine\\System\\Services\\echo");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (!NT_SUCCESS(ZwOpenKey(&echoKey, KEY_QUERY_VALUE, &attributes))) return;
    status = ZwEnumerateValueKey(echoKey, 0, KeyValueBasicInformation,
                                 buffer, sizeof(buffer), &length);
    ZwClose(echoKey);
    if (!NT_SUCCESS(status)) return;
    {
        KEY_VALUE_BASIC_INFORMATION *info = (KEY_VALUE_BASIC_INFORMATION *)buffer;
        static const wchar_t expected[] = L"DriverFile";
        ULONG i;
        if (info->NameLength != 10 * sizeof(wchar_t)) return;
        for (i = 0; i < 10; i++)
            if (info->Name[i] != expected[i]) return;
    }

    /* create + delete: a chave some de verdade */
    RtlInitUnicodeString(&path,
                         L"\\Registry\\Machine\\System\\Services\\TestDel");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (!NT_SUCCESS(ZwCreateKey(&testKey, DELETE, &attributes, 0, NULL, 0,
                                NULL))) return;
    if (!NT_SUCCESS(ZwDeleteKey(testKey))) { ZwClose(testKey); return; }
    ZwClose(testKey);
    if (NT_SUCCESS(ZwOpenKey(&reopened, 0, &attributes))) {
        ZwClose(reopened);
        return;   /* nao deveria existir mais */
    }
    allPassed |= 2;
}

static void testStall(void) {
    LARGE_INTEGER frequency, startCounter, endCounter;
    ULONG64 elapsedUs;
    startCounter = KeQueryPerformanceCounter(&frequency);
    KeStallExecutionProcessor(500);             /* 500 us de stall real */
    endCounter = KeQueryPerformanceCounter(NULL);
    if (!frequency.QuadPart) return;
    elapsedUs = ((endCounter.QuadPart - startCounter.QuadPart) * 1000000) /
                frequency.QuadPart;
    if (elapsedUs >= 490) allPassed |= 4;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("mmio.sys: DriverEntry\r\n");
    allPassed = 0;
    testMmioLapic();
    testRegistryEnum();
    testStall();
    driverObject->MajorFunction[IRP_MJ_READ] = mmioRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Mmio");
}
