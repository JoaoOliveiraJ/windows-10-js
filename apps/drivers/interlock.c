/*
 * interlock.c - Interlocked* atomicas reais. \Device\Interlock devolve
 * "interlock-ok" se Increment/Decrement/Exchange/CompareExchange baterem.
 */
#include "jsos-driver.h"

static LONG counter;
static int allPassed;

static NTSTATUS interlockRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "interlock-ok" : "interlock-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    int ok = 1;
    (void)registryPath;
    DbgPrint("interlock.sys: DriverEntry\r\n");

    counter = 41;
    if (InterlockedIncrement(&counter) != 42) ok = 0;
    if (InterlockedDecrement(&counter) != 41) ok = 0;
    if (InterlockedExchange(&counter, 77) != 41) ok = 0;
    if (counter != 77) ok = 0;
    if (InterlockedCompareExchange(&counter, 99, 77) != 77) ok = 0;
    if (counter != 99) ok = 0;
    if (InterlockedCompareExchange(&counter, 1, 77) != 99) ok = 0;
    if (counter != 99) ok = 0;
    allPassed = ok;

    driverObject->MajorFunction[IRP_MJ_READ] = interlockRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Interlock");
}
