; ---------------------------------------------------------------------------
; aptrampoline.asm - trampolim de Application Processor (AP), SIPI real mode
; -> protegido -> long mode. Unico codigo de CPU nova (logica toda em JS).
;
; O BSP (system32/ntos/ke/smp.js) copia este binario p/ 0x9000, preenche o
; mailbox em 0xA000 (CR3, stack, slot) e dispara INIT-SIPI-SIPI pelo LAPIC.
; O AP entra aqui em modo real (CS=0x900), sobe p/ 64 bits com o MESMO CR3
; do BSP, marca seu slot online e entra no loop de jobs nativos:
;   SLOT_JOB_FUNC != 0 -> chama func(args 1..4) MS ABI -> SLOT_JOB_RESULT,
;   SLOT_JOB_DONE = 1. Assim codigo nativo roda DE VERDADE em outro CPU
;   enquanto o BSP segue no JavaScript.
; ---------------------------------------------------------------------------
[org 0x9000]
[bits 16]

%define SMP_MAILBOX   0xA000
%define MB_MAGIC      0x00
%define MB_ONLINE     0x04
%define MB_ACK        0x08
%define MB_BOOTSLOT   0x0C
%define MB_BOOTSTACK  0x10
%define MB_CR3        0x18
%define MB_SLOTS      0x100

%define SLOT_SIZE     64
%define SLOT_APIC_ID  0x00
%define SLOT_ONLINE   0x04
%define SLOT_JOB_FUNC 0x08
%define SLOT_JOB_ARG1 0x10
%define SLOT_JOB_ARG2 0x18
%define SLOT_JOB_ARG3 0x20
%define SLOT_JOB_ARG4 0x28
%define SLOT_JOB_RES  0x30
%define SLOT_JOB_DONE 0x38

%define LAPIC_ID      0xFEE00020

%define MB_DEBUG16    0x20          ; marcadores de progresso do AP (debug)
%define MB_DEBUG32    0x24
%define MB_DEBUG64    0x28

start:
        cli
        xor ax, ax
        mov ds, ax
        mov es, ax
        mov ss, ax
        mov dword [SMP_MAILBOX + MB_DEBUG16], 0x16    ; AP vivo em modo real
        lgdt [gdtr]
        mov eax, cr0
        or eax, 1                   ; PE
        mov cr0, eax
        jmp dword 0x08:pm32

; --- stub de NMI a offset FIXO 0x40 (IVT[2] aponta aqui) ------------------
; WHPX (kernel-irqchip=off) processa o SIPI mas nao limpa o "halted" do vCPU
; (ver smp.js); um NMI de IPI limpa. O NMI e entregue na entrada do AP e cai
; neste iret, que devolve a execucao para o inicio do trampolim. Indolor em
; hardware real tambem (IVT[2] sempre deve ter um handler valido).
times 0x40-($-$$) db 0
nmi_iret:
        iret

; ---------------------------------------------------------------------------
[bits 32]
pm32:
        mov ax, 0x10
        mov ds, ax
        mov es, ax
        mov ss, ax
        mov dword [SMP_MAILBOX + MB_DEBUG32], 0x32    ; AP em modo protegido
        mov eax, cr4
        or eax, 0x620               ; PAE|OSFXSR|OSXMMEXCPT (igual ao BSP)
        mov cr4, eax
        mov eax, [SMP_MAILBOX + MB_CR3]
        mov cr3, eax                ; mesmas tabelas de paginas do BSP
        mov ecx, 0xC0000080         ; EFER
        rdmsr
        or eax, 0x100               ; LME
        wrmsr
        mov eax, cr0
        and eax, 0xFFFFFFFB         ; EM=0
        or eax, 0x80000022          ; PG|MP|NE
        mov cr0, eax
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
        mov dword [SMP_MAILBOX + MB_DEBUG64], 0x64    ; AP em long mode
        mov rsp, [SMP_MAILBOX + MB_BOOTSTACK]

        ; slot = MB_BOOTSLOT; registro do slot = MB_SLOTS + slot*SLOT_SIZE
        mov ebx, [SMP_MAILBOX + MB_BOOTSLOT]
        shl rbx, 6                  ; * 64 (SLOT_SIZE)
        lea r15, [rbx + SMP_MAILBOX + MB_SLOTS]

        ; registra o proprio APIC ID (LAPIC MMIO) e marca online
        mov eax, [LAPIC_ID]
        shr eax, 24
        mov [r15 + SLOT_APIC_ID], eax
        mov dword [r15 + SLOT_JOB_DONE], 1
        mov dword [r15 + SLOT_ONLINE], 1
        lock inc dword [SMP_MAILBOX + MB_ONLINE]
        mov dword [SMP_MAILBOX + MB_ACK], 1     ; handshake p/ o BSP

        ; loop de jobs: func(arg1..arg4) MS ABI, resultado no slot
.jobloop:
        mov rax, [r15 + SLOT_JOB_FUNC]
        test rax, rax
        jnz .runjob
        pause
        jmp .jobloop
.runjob:
        mov rcx, [r15 + SLOT_JOB_ARG1]
        mov rdx, [r15 + SLOT_JOB_ARG2]
        mov r8,  [r15 + SLOT_JOB_ARG3]
        mov r9,  [r15 + SLOT_JOB_ARG4]
        mov qword [r15 + SLOT_JOB_FUNC], 0
        and rsp, -16                ; alinhamento da ABI MS x64 no call
        call rax
        mov [r15 + SLOT_JOB_RES], rax
        mov dword [r15 + SLOT_JOB_DONE], 1
        jmp .jobloop

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
