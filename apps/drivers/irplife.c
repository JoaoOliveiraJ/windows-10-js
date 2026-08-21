/*
 * irplife.c - driver demo do grupo "ciclo de vida de IRP" do jsOS.
 * Usa IoAllocateIrp / IoCompleteRequest / IoFreeIrp e cria \Device\IrpLife,
 * cujo READ nativo devolve "irp-life-ok".
 */

typedef unsigned long long ULONG64;
typedef unsigned int ULONG;
typedef unsigned short USHORT;
typedef long NTSTATUS;
typedef USHORT wchar_t;

typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } UNICODE_STRING;
typedef struct { ULONG64 DispatchTable; ULONG64 DeviceList; } JSOS_DRIVER_OBJECT;
typedef struct {
    ULONG MajorFunction;
    ULONG Status;
    ULONG64 Buffer;
    ULONG64 BufferLength;
    ULONG64 ResultLength;
} JSOS_IRP;

#define IRP_MJ_READ  3
#define IRP_MJ_WRITE 4
#define STATUS_SUCCESS 0

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) ULONG64 IoAllocateIrp(ULONG stackSize, ULONG chargeQuota);
__declspec(dllimport) void IoFreeIrp(ULONG64 irp);
__declspec(dllimport) void IoCompleteRequest(ULONG64 irp, ULONG priorityBoost);

static NTSTATUS lifeRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = "irp-life-ok";
    char *buffer = (char *)(ULONG64)irp->Buffer;
    ULONG length = 0, i;
    (void)devicePtr;
    while (message[length]) length++;
    if (length > irp->BufferLength) length = irp->BufferLength;
    for (i = 0; i < length; i++) buffer[i] = message[i];
    irp->ResultLength = length;
    irp->Status = STATUS_SUCCESS;
    return STATUS_SUCCESS;
}

NTSTATUS DriverEntry(ULONG64 driverObjectPtr, ULONG64 registryPath) {
    JSOS_DRIVER_OBJECT *driverObject = (JSOS_DRIVER_OBJECT *)(ULONG64)driverObjectPtr;
    ULONG64 *dispatch = (ULONG64 *)(ULONG64)driverObject->DispatchTable;
    ULONG64 irpPtr;
    JSOS_IRP *irp;
    UNICODE_STRING deviceName;
    ULONG64 devicePtr = 0;
    (void)registryPath;

    DbgPrint("irplife.sys: DriverEntry\r\n");

    /* ciclo de vida do IRP: aloca, marca pendente, completa, libera */
    irpPtr = IoAllocateIrp(2, 0);
    if (!irpPtr) {
        DbgPrint("irplife.sys: IoAllocateIrp falhou\r\n");
        return 1;
    }
    irp = (JSOS_IRP *)(ULONG64)irpPtr;
    irp->MajorFunction = IRP_MJ_WRITE;
    irp->Status = 0x103;                     /* STATUS_PENDING */
    IoCompleteRequest(irpPtr, 0);            /* nosso export zera o status */
    if (irp->Status != STATUS_SUCCESS) {
        DbgPrint("irplife.sys: IoCompleteRequest sem efeito\r\n");
        IoFreeIrp(irpPtr);
        return 2;
    }
    IoFreeIrp(irpPtr);

    /* dispositivo com READ nativo */
    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&lifeRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\IrpLife");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint("irplife.sys: \\Device\\IrpLife pronto\r\n");
    return STATUS_SUCCESS;
}
