/* link.ld - kernel do jsOS linkado em 0x100000 (1MB), identity-mapped */
ENTRY(kernel_main)
OUTPUT_FORMAT(elf64-x86-64)

SECTIONS
{
    . = 0x100000;

    /* entry primeiro: o stage2 salta para 0x100000 */
    .text : ALIGN(16) {
        *(.text.boot)
        *(.text .text.*)
    }
    .rodata : ALIGN(16) { *(.rodata .rodata.* .rodata1) }
    .data   : ALIGN(16) { *(.data .data.*) }
    .bss    : ALIGN(16) {
        __bss_start = .;
        *(.bss .bss.* COMMON)
        . = ALIGN(16);
        __bss_end = .;
    }

    __kernel_end = .;

    /DISCARD/ : { *(.note*) *(.comment*) *(.eh_frame*) *(.eh_frame_hdr*) }
}
