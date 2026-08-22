/*
 * mmmem.c - MmAllocateNonCachedMemory / MmFreeNonCachedMemory com free real.
 * \Device\MmMem devolve "mm-mem-ok" se alocar/gravar/ler/liberar/reusar bater.
 */
#include "jsos-driver.h"

static int allPassed;

static NTSTATUS mmmemRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "mm-mem-ok" : "mm-mem-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    PVOID block, again;
    ULONG i;
    int ok = 1;
    (void)registryPath;
    DbgPrint("mmmem.sys: DriverEntry\r\n");

    block = MmAllocateNonCachedMemory(8192);
    if (block) {
        unsigned char *bytes = (unsigned char *)block;
        for (i = 0; i < 8192; i++) bytes[i] = 0x5A;
        for (i = 0; i < 8192; i++) if (bytes[i] != 0x5A) { ok = 0; break; }
        MmFreeNonCachedMemory(block, 8192);
        /* free real: realocar o mesmo tamanho deve reusar o endereco */
        again = MmAllocateNonCachedMemory(8192);
        if (again != block) ok = 0;
        if (again) MmFreeNonCachedMemory(again, 8192);
    } else {
        ok = 0;
    }
    allPassed = ok;

    driverObject->MajorFunction[IRP_MJ_READ] = mmmemRead;
    return JsosCreateDevice(driverObject, L"\\Device\\MmMem");
}
