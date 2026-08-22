/*
 * registry.c - Registry Zw* real: ZwCreateKey/ZwSetValueKey/ZwOpenKey/
 * ZwQueryValueKey/ZwClose. \Device\Registry devolve "registry-ok".
 */
#include "jsos-driver.h"

static int allPassed;

static NTSTATUS registryRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "registry-ok" : "registry-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    UNICODE_STRING keyName, valueName;
    OBJECT_ATTRIBUTES attrs;
    HANDLE keyHandle = NULL;
    ULONG resultLength = 0;
    unsigned char readBuffer[64];
    ULONG i;
    int ok = 1;
    const char expected[] = "jsOS!";
    (void)registryPath;

    DbgPrint("registry.sys: DriverEntry\r\n");

    RtlInitUnicodeString(&keyName, L"\\Registry\\Machine\\Software\\jsOS");
    InitializeObjectAttributes(&attrs, &keyName, OBJ_CASE_INSENSITIVE, NULL, NULL);

    if (!NT_SUCCESS(ZwCreateKey(&keyHandle, KEY_ALL_ACCESS, &attrs, 0, NULL, 0, NULL))) ok = 0;
    if (ok && keyHandle) {
        RtlInitUnicodeString(&valueName, L"Magic");
        if (!NT_SUCCESS(ZwSetValueKey(keyHandle, &valueName, 0, REG_SZ,
                                      (PVOID)expected, sizeof(expected)))) ok = 0;
        ZwClose(keyHandle);
        keyHandle = NULL;
    }

    if (ok && NT_SUCCESS(ZwOpenKey(&keyHandle, KEY_READ, &attrs))) {
        RtlZeroMemory(readBuffer, sizeof(readBuffer));
        if (NT_SUCCESS(ZwQueryValueKey(keyHandle, &valueName, KeyValueBasicInformation,
                                       readBuffer, sizeof(readBuffer), &resultLength))) {
            KEY_VALUE_BASIC_INFORMATION *info = (KEY_VALUE_BASIC_INFORMATION *)readBuffer;
            /* le o conteudo do valor via a classe full */
            (void)info;
            if (!NT_SUCCESS(ZwQueryValueKey(keyHandle, &valueName, KeyValuePartialInformation,
                                            readBuffer, sizeof(readBuffer), &resultLength))) ok = 0;
            else {
                KEY_VALUE_PARTIAL_INFORMATION *partial =
                    (KEY_VALUE_PARTIAL_INFORMATION *)readBuffer;
                if (partial->DataLength != sizeof(expected)) ok = 0;
                else for (i = 0; i < partial->DataLength; i++)
                    if (partial->Data[i] != expected[i]) ok = 0;
            }
        } else ok = 0;
        ZwClose(keyHandle);
    } else if (ok) ok = 0;

    allPassed = ok;

    driverObject->MajorFunction[IRP_MJ_READ] = registryRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Registry");
}
