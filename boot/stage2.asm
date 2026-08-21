; ---------------------------------------------------------------------------
; stage2.asm - modo real -> protegido -> long mode (64 bits).
;
; 1. E820 (mapa de memoria) -> 0x4FF0 (count u16) / 0x5000 (entradas 24B)
; 2. A20 via porta 0x92
; 3. Modo protegido (GDT flat)
; 4. Kernel do disco p/ 0x100000 via ATA PIO (LBA 65, sem BIOS)
; 5. Paginacao identity 4GB (2MB pages), SSE habilitado
; 6. PAE + LME -> long mode, stack em 0x300000, salta p/ 0x100000
;
; Marcadores de progresso na serial COM1: B E A P K G L 6
;
; ATENCAO: codigo 16-bit NAO pode ser chamado de codigo 32/64-bit (mesmos
; bytes decodificam diferente). Por isso existem sputc16 e sputc32.
; ---------------------------------------------------------------------------
[org 0x7E00]
[bits 16]

        jmp short start
        nop
kernel_sectors: dw 0            ; patcheado pelo build (offset 3)

%define E820_COUNT   0x4FF0
%define E820_TABLE   0x5000
%define PML4         0x70000
%define PDPT         0x71000
%define PD0          0x72000    ; PD0..PD3 = 0x72000..0x75FFF
%define KERNEL_LBA   65
%define KERNEL_DEST  0x100000
; rsp % 16 == 8 na entrada da funcao C (ABI SysV, como se viesse de um call)
%define STACK_TOP    0x300008

; --- serial putc, MODO REAL 16-bit apenas (AL = char; clobbera dx) --------
sputc16:
        push ax
        mov dx, 0x3FD
.w:     in al, dx
        test al, 0x20
        jz .w
        pop ax
        mov dx, 0x3F8
        out dx, al
        ret

start:
        cli
        mov al, 0x80            ; mascara NMI (IDT ainda nao existe)
        out 0x70, al
        xor ax, ax
        mov ds, ax
        mov es, ax
        mov ss, ax
        mov sp, 0x7C00

        ; serial COM1: 38400 8N1
        mov dx, 0x3F9
        xor al, al
        out dx, al
        mov dx, 0x3FB
        mov al, 0x80
        out dx, al
        mov dx, 0x3F8
        mov al, 0x03
        out dx, al
        mov dx, 0x3F9
        xor al, al
        out dx, al
        mov dx, 0x3FB
        mov al, 0x03
        out dx, al
        mov dx, 0x3FA
        mov al, 0xC7
        out dx, al
        mov dx, 0x3FC
        mov al, 0x0B
        out dx, al

        mov al, 'B'
        call sputc16

        ; ---- E820 ----
        mov di, E820_TABLE
        xor ebx, ebx
        xor bp, bp
        mov edx, 0x534D4150
.e8:    mov eax, 0xE820
        mov ecx, 24
        mov dword [di+20], 1
        int 0x15
        jc .e8done
        cmp eax, 0x534D4150
        jne .e8done
        test ecx, ecx
        jz .e8skip
        inc bp
        add di, 24
.e8skip:
        test ebx, ebx
        jnz .e8
.e8done:
        mov [E820_COUNT], bp
        mov al, 'E'
        call sputc16

        ; ---- A20 (porta 0x92) ----
        in al, 0x92
        or al, 2
        out 0x92, al
        mov al, 'A'
        call sputc16

        ; ---- entra no modo protegido ----
        lgdt [gdtr]
        mov eax, cr0
        or eax, 1
        mov cr0, eax
        jmp dword 0x08:pm32

; ---------------------------------------------------------------------------
[bits 32]

; --- serial putc, 32-bit; os mesmos bytes sao validos em 64-bit ----------
sputc32:
        push eax                ; em 64-bit vira push rax; pop casa
        mov dx, 0x3FD           ; 66 BA ... igual nas duas decodificacoes
.w:     in al, dx
        test al, 0x20
        jz .w
        pop eax
        mov dx, 0x3F8
        out dx, al
        ret

pm32:
        mov ax, 0x10
        mov ds, ax
        mov es, ax
        mov ss, ax
        mov fs, ax
        mov gs, ax
        mov al, 'P'
        call sputc32

        ; ---- ATA PIO: kernel_sectors setores do LBA KERNEL_LBA p/ 0x100000
        movzx ecx, word [kernel_sectors]
        test ecx, ecx
        jz .nodisk
        mov [sectors_left], ecx
        mov esi, KERNEL_LBA
        mov edi, KERNEL_DEST
.sector:
        mov dx, 0x1F7
.wbsy:  in al, dx
        test al, 0x80
        jnz .wbsy
        mov dx, 0x1F2
        mov al, 1
        out dx, al
        mov dx, 0x1F3
        mov eax, esi
        out dx, al
        shr eax, 8
        mov dx, 0x1F4
        out dx, al
        shr eax, 8
        mov dx, 0x1F5
        out dx, al
        shr eax, 8
        and al, 0x0F
        or al, 0xE0
        mov dx, 0x1F6
        out dx, al
        mov dx, 0x1F7
        mov al, 0x20                ; READ SECTORS
        out dx, al
.wdrq:  in al, dx
        test al, 0x80
        jnz .wdrq
        test al, 0x08               ; DRQ
        jz .wdrq
        mov ecx, 256
        mov dx, 0x1F0
        rep insw                    ; 256 words = 512 bytes p/ ES:EDI
        inc esi
        dec dword [sectors_left]
        jnz .sector
.nodisk:
        mov al, 'K'
        call sputc32

        ; ---- paginacao identity 4GB ----
        mov edi, PML4
        xor eax, eax
        mov ecx, 0x6000 / 4
        rep stosd
        mov dword [PML4], PDPT | 3
        mov dword [PDPT],      PD0 | 3
        mov dword [PDPT+8],    (PD0+0x1000) | 3
        mov dword [PDPT+16],   (PD0+0x2000) | 3
        mov dword [PDPT+24],   (PD0+0x3000) | 3
        mov edi, PD0
        mov eax, 0x83               ; present|rw|page-size(2MB)
        mov ecx, 2048
.fill:  mov [edi], eax
        mov dword [edi+4], 0
        add eax, 0x200000
        add edi, 8
        dec ecx
        jnz .fill
        mov al, 'G'
        call sputc32

        ; ---- SSE (CR0.MP|NE, CR0.EM=0; CR4.OSFXSR|OSXMMEXCPT|PAE) ----
        mov eax, cr0
        and eax, 0xFFFFFFFB
        or eax, 0x22
        mov cr0, eax
        mov eax, cr4
        or eax, 0x620
        mov cr4, eax

        ; ---- long mode ----
        mov eax, PML4
        mov cr3, eax
        mov ecx, 0xC0000080         ; EFER
        rdmsr
        or eax, 0x100               ; LME
        wrmsr
        mov eax, cr0
        or eax, 0x80000000          ; PG
        mov cr0, eax
        mov al, 'L'
        call sputc32
        jmp 0x18:lm64

; ---------------------------------------------------------------------------
[bits 64]
lm64:
        mov ax, 0x20
        mov ds, ax
        mov es, ax
        mov ss, ax
        mov fs, ax
        mov gs, ax
        mov rsp, STACK_TOP
        mov al, '6'
        call sputc32                ; bytes 32-bit validos aqui tambem
        mov rax, KERNEL_DEST
        jmp rax

; ---------------------------------------------------------------------------
align 8
gdt:
        dq 0                        ; null
        dq 0x00CF9A000000FFFF       ; 0x08 code32
        dq 0x00CF92000000FFFF       ; 0x10 data32
        dq 0x00209A0000000000       ; 0x18 code64 (L=1)
        dq 0x0000920000000000       ; 0x20 data64
gdt_end:

align 4
gdtr:   dw gdt_end - gdt - 1
        dd gdt

sectors_left: dd 0
