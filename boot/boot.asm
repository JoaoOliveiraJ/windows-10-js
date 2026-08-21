; ---------------------------------------------------------------------------
; boot.asm - setor de boot (512 bytes) do jsOS.
; A BIOS nos carrega em 0x7C00 em modo real. Carregamos o stage2 (64 setores
; a partir do LBA 1) para 0x7E00 via int 13h LBA e saltamos para ele.
; ---------------------------------------------------------------------------
[org 0x7C00]
[bits 16]

%define STAGE2_SECTORS 64
%define STAGE2_LBA     1

start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00
    sti
    mov [boot_drive], dl

    mov si, dap
    mov ah, 0x42                ; int 13h LBA read (EDD)
    mov dl, [boot_drive]
    int 0x13
    jc disk_error

    jmp 0x0000:0x7E00

disk_error:
    mov si, msg_err
.print:
    lodsb
    or al, al
    jz .halt
    mov ah, 0x0E
    int 0x10
    jmp .print
.halt:
    cli
    hlt

boot_drive: db 0
msg_err: db "boot: erro de disco", 0

align 4
dap:
    db 0x10, 0x00               ; tamanho do DAP, reservado
    dw STAGE2_SECTORS           ; setores a ler
    dw 0x7E00                   ; offset destino
    dw 0x0000                   ; segmento destino
    dq STAGE2_LBA               ; LBA inicial

times 510-($-$$) db 0
dw 0xAA55
