/*
 * atadrv.c - driver de storage nativo estilo Windows: le o disco IDE slave
 * DE VERDADE com ATA PIO via HAL (READ_PORT_UCHAR/WRITE_PORT_UCHAR/
 * READ_PORT_USHORT das portas 0x1F0-0x1F7) e valida o boot sector NTFS
 * ("NTFS    " no offset 3). \Device\AtaDrv READ devolve "atadrv-ok".
 */
#include "jsos-driver.h"

#define ATA_DATA     ((PUCHAR)(ULONG_PTR)0x1F0)
#define ATA_SECTORS  ((PUCHAR)(ULONG_PTR)0x1F2)
#define ATA_LBA_LO   ((PUCHAR)(ULONG_PTR)0x1F3)
#define ATA_LBA_MID  ((PUCHAR)(ULONG_PTR)0x1F4)
#define ATA_LBA_HI   ((PUCHAR)(ULONG_PTR)0x1F5)
#define ATA_DRIVE    ((PUCHAR)(ULONG_PTR)0x1F6)
#define ATA_STATUS   ((PUCHAR)(ULONG_PTR)0x1F7)
#define ATA_CMD      ((PUCHAR)(ULONG_PTR)0x1F7)
#define ATA_CMD_READ 0x20
#define ATA_SR_BSY   0x80
#define ATA_SR_DRQ   0x08
#define ATA_SR_ERR   0x01

static ULONG diskPassed;

/* le 1 setor (512B) do drive slave (o NTFS de teste), LBA28 */
static int ataReadSector(ULONG lba, USHORT *out) {
    ULONG i;
    UCHAR status;
    while (READ_PORT_UCHAR(ATA_STATUS) & ATA_SR_BSY) { }
    WRITE_PORT_UCHAR(ATA_SECTORS, 1);
    WRITE_PORT_UCHAR(ATA_LBA_LO, (UCHAR)(lba & 0xFF));
    WRITE_PORT_UCHAR(ATA_LBA_MID, (UCHAR)((lba >> 8) & 0xFF));
    WRITE_PORT_UCHAR(ATA_LBA_HI, (UCHAR)((lba >> 16) & 0xFF));
    WRITE_PORT_UCHAR(ATA_DRIVE, (UCHAR)(0xE0 | 0x10 | ((lba >> 24) & 0x0F)));
    WRITE_PORT_UCHAR(ATA_CMD, ATA_CMD_READ);
    for (;;) {
        status = READ_PORT_UCHAR(ATA_STATUS);
        if (status & ATA_SR_ERR) return 0;
        if (!(status & ATA_SR_BSY) && (status & ATA_SR_DRQ)) break;
    }
    for (i = 0; i < 256; i++)
        out[i] = READ_PORT_USHORT((PUSHORT)ATA_DATA);
    return 1;
}

static NTSTATUS atadrvRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, diskPassed ? "atadrv-ok"
                                                             : "atadrv-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    static USHORT bootSector[256];
    char *signature;
    (void)registryPath;
    DbgPrint("atadrv.sys: DriverEntry\r\n");

    /* LBA 0 do slave: boot sector do NTFS de teste */
    if (ataReadSector(0, bootSector)) {
        signature = (char *)bootSector + 3;
        if (signature[0] == 'N' && signature[1] == 'T' &&
            signature[2] == 'F' && signature[3] == 'S')
            diskPassed = 1;
    }
    DbgPrint(diskPassed ? "atadrv.sys: disco lido, NTFS detectado\r\n"
                        : "atadrv.sys: FALHA na leitura do disco\r\n");

    driverObject->MajorFunction[IRP_MJ_READ] = atadrvRead;
    return JsosCreateDevice(driverObject, L"\\Device\\AtaDrv");
}
