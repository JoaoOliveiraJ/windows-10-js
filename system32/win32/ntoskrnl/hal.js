// ===========================================================================
// jsOS - system32/win32/ntoskrnl/hal.js: exports da HAL.dll (I/O de porta
// e afins). No NT/x64, READ_PORT_*/WRITE_PORT_* sao funcoes reais da HAL;
// aqui descem para as primitivas de porta do host.
// ===========================================================================

module.exports = {
    names: [
        'READ_PORT_UCHAR',
        'READ_PORT_USHORT',
        'READ_PORT_ULONG',
        'WRITE_PORT_UCHAR',
        'WRITE_PORT_USHORT',
        'WRITE_PORT_ULONG',
    ],
    handlers: [
        // READ_PORT_UCHAR(portPtr) -> u8
        (portPointer) => os.readPort8(portPointer >>> 0),
        // READ_PORT_USHORT(portPtr) -> u16
        (portPointer) => os.readPort16(portPointer >>> 0),
        // READ_PORT_ULONG(portPtr) -> u32
        (portPointer) => os.readPort32(portPointer >>> 0),
        // WRITE_PORT_UCHAR(portPtr, value)
        (portPointer, value) => {
            os.writePort8(portPointer >>> 0, value & 0xFF);
            return 0;
        },
        // WRITE_PORT_USHORT(portPtr, value)
        (portPointer, value) => {
            os.writePort16(portPointer >>> 0, value & 0xFFFF);
            return 0;
        },
        // WRITE_PORT_ULONG(portPtr, value)
        (portPointer, value) => {
            os.writePort32(portPointer >>> 0, value >>> 0);
            return 0;
        },
    ],
};
