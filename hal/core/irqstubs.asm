; ---------------------------------------------------------------------------
; irqstubs.asm - trampolins de interrupcao (hardware exige codigo de maquina
; no vetor da IDT; a LOGICA toda fica no JavaScript).
;
; Cada stub: marca o vetor em edi, salva os registradores, registra o evento
; na memoria compartilhada (leitura pelo JS via os.readPhysical*), faz EOI no
; PIC, restaura e iretq. Nao chama C nem JS (seguro em contexto de IRQ).
;
; Mapa de memoria fisica compartilhada:
;   0x81000: u32 irq_count[256]       (contagem de interrupcoes por vetor)
;   0x81400: ring buffer do teclado   (head u32 @0x81400, tail u32 @0x81404,
;                                      dados 256B @0x81408)
; ---------------------------------------------------------------------------
[bits 64]

%define NSTUBS      256
%define IRQ_COUNT   0x81000
%define KBD_HEAD    0x81400
%define KBD_TAIL    0x81404
%define KBD_DATA    0x81408
%define LAPIC_EOI   0xFEE000B0

extern jsos_irq_native_dispatch

global irq_stub_table

align 16
irq_stub_table:
%assign i 0
%rep NSTUBS
    push byte i             ; 2 bytes (6A) — vetor na pilha, SEM clobberar regs
    jmp strict near irq_common     ; 5 bytes (E9 rel32 FORCADO)
    nop                     ; alinhamento do stub em 10 bytes
    nop
    nop
%assign i i+1
%endrep

align 16
irq_common:
    push rax
    push rcx
    push rdx
    push rsi
    push rdi                    ; TODOS os regs usados pelo stub (IRQ chega
    push r8                     ; em qualquer ponto — nada pode ser clobberado)
    push r9
    push r10
    push r11
    movzx edi, byte [rsp + 72]  ; vetor (push byte sign-extends: le so o byte)

    ; irq_count[edi]++
    mov eax, IRQ_COUNT
    inc dword [rax + rdi*4]

    ; excecoes (vetores 0-31) E o int 0x29 (failfast do Windows): NAO da p/
    ; iret cego (voltaria na mesma instrucao ou em padding). Diagnostico e halt.
    cmp edi, 0x20
    jae .maybe_failfast
    jmp .is_exception
.maybe_failfast:
    cmp edi, 0x29                ; int 0x29 = KiRaiseSecurityCheckFailure
    jne .is_irq
.is_exception:
    ; imprime "EX:#NN @ RIP" em COM1 (hex do vetor + RIP da falha) e halt
    mov dx, 0x3F8
    mov al, 'E'
    out dx, al
    mov al, 'X'
    out dx, al
    mov al, ':'
    out dx, al
    mov eax, edi
    shr eax, 4
    call .hexdig
    mov eax, edi
    and eax, 15
    call .hexdig
    mov al, ' '
    out dx, al
    mov al, '@'
    out dx, al
    mov al, ' '
    out dx, al
    ; RIP da falha: com error code (#DF 8, #TS 10, #NP 11, #SS 12, #GP 13,
    ; #PF 14, #AC 17, #VC 29, #SX 30) esta em [rsp+88]; sem, em [rsp+80]
    mov r10d, edi
    cmp r10d, 8
    je .with_error_code
    cmp r10d, 10
    je .with_error_code
    cmp r10d, 11
    je .with_error_code
    cmp r10d, 12
    je .with_error_code
    cmp r10d, 13
    je .with_error_code
    cmp r10d, 14
    je .with_error_code
    cmp r10d, 17
    je .with_error_code
    cmp r10d, 21
    je .with_error_code
    cmp r10d, 29
    je .with_error_code
    cmp r10d, 30
    je .with_error_code
    mov r10, [rsp + 80]
    jmp .rip_digits
.with_error_code:
    mov r10, [rsp + 88]
.rip_digits:
    mov ecx, 16
.ripdig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .ripdig
    mov al, ' '
    out dx, al
    mov al, 'S'
    out dx, al
    mov al, 'P'
    out dx, al
    mov al, '='
    out dx, al
    mov r10, [rsp + 96]      ; RSP salvo no frame (se houver) / aproximado
    mov ecx, 16
.rspdig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .rspdig
    ; imprime RDX e RCX salvos (registradores no momento da falha)
    mov al, ' '
    out dx, al
    mov al, 'D'
    out dx, al
    mov al, '='
    out dx, al
    mov r10, [rsp + 48]      ; rdx salvo
    mov ecx, 16
.rdxdig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .rdxdig
    mov al, ' '
    out dx, al
    mov al, 'C'
    out dx, al
    mov al, '='
    out dx, al
    mov r10, [rsp + 56]      ; rcx salvo
    mov ecx, 16
.rcxdig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .rcxdig
    ; RSP da falha esta em [rsp+112] (frame com error code); [RSP] = retorno
    mov al, ' '
    out dx, al
    mov al, 'R'
    out dx, al
    mov al, 'A'
    out dx, al
    mov al, '='
    out dx, al
    mov r10, [rsp + 112]     ; RSP no momento da falha
    mov r10, [r10]           ; endereco de retorno do chamador
    mov ecx, 16
.radig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .radig
    ; CR2 (endereco da falha em #PF)
    mov al, ' '
    out dx, al
    mov al, 'C'
    out dx, al
    mov al, 'R'
    out dx, al
    mov al, '2'
    out dx, al
    mov al, '='
    out dx, al
    mov r10, cr2
    mov ecx, 16
.cr2dig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .cr2dig
    mov al, 0x0D
    out dx, al
    mov al, 0x0A
    out dx, al
    ; dump da pilha da falha (32 qwords): vetores sem error code (int 0x29
    ; inclusive) tem o RSP da falha em rsp+104 (72 regs + 8 vetor + 24 frame
    ; CPU ring0). O 1o qword e' o retorno p/ a funcao que falhou (int 0x29).
    mov al, 'S'
    out dx, al
    mov al, 'T'
    out dx, al
    mov al, ' '
    out dx, al
    mov r10, rsp
    add r10, 104
    ; BASE = endereco absoluto do qword +00 do dump
    push r10
    mov al, 'B'
    out dx, al
    mov al, '='
    out dx, al
    mov r10, [rsp]
    mov ecx, 16
.basedig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .basedig
    pop r10
    xor r11d, r11d
.stkdump:
    mov al, ' '
    out dx, al
    mov eax, r11d
    shl eax, 3
    mov r9d, eax
    shr eax, 4
    call .hexdig
    mov eax, r9d
    and eax, 15
    call .hexdig
    mov al, '='
    out dx, al
    mov r9, [r10 + r11*8]
    mov ecx, 16
.stkval:
    rol r9, 4
    mov eax, r9d
    call .hexdig
    dec ecx
    jnz .stkval
    inc r11d
    cmp r11d, 32
    jb .stkdump
    mov al, 0x0D
    out dx, al
    mov al, 0x0A
    out dx, al
    cli
    hlt
.hexdig:
    and eax, 15
    cmp eax, 10
    jb .digit
    add eax, 'A' - 10
    jmp .emit
.digit:
    add eax, '0'
.emit:
    out dx, al
    ret

.is_irq:
    ; ---- despacho imediato de ISR nativa (drivers Windows reais) ----------
    ; o C (jsos_irq_native_dispatch) decide: se o vetor tem cadeia KINTERRUPT
    ; e o IRQL atual < DIRQL do vetor, a ISR roda AGORA (preempcao estilo
    ; NT/HAL). Salva o estado COMPLETO (o caminho C->JS->ISR nativa clobbera
    ; tudo: GP regs + XMM0-15).
    push rbx
    push rbp
    push r12
    push r13
    push r14
    push r15
    sub rsp, 0x100
    movdqu [rsp + 0x00], xmm0
    movdqu [rsp + 0x10], xmm1
    movdqu [rsp + 0x20], xmm2
    movdqu [rsp + 0x30], xmm3
    movdqu [rsp + 0x40], xmm4
    movdqu [rsp + 0x50], xmm5
    movdqu [rsp + 0x60], xmm6
    movdqu [rsp + 0x70], xmm7
    movdqu [rsp + 0x80], xmm8
    movdqu [rsp + 0x90], xmm9
    movdqu [rsp + 0xA0], xmm10
    movdqu [rsp + 0xB0], xmm11
    movdqu [rsp + 0xC0], xmm12
    movdqu [rsp + 0xD0], xmm13
    movdqu [rsp + 0xE0], xmm14
    movdqu [rsp + 0xF0], xmm15
    mov ebx, edi                  ; o vetor sobrevive ao call em rbx
    mov rbp, rsp
    and rsp, -16                  ; alinhamento SysV/MS p/ o call C
    call jsos_irq_native_dispatch ; edi = vetor (arg1)
    mov rsp, rbp
    mov edi, ebx                  ; restaura o vetor p/ o fluxo abaixo
    movdqu xmm0, [rsp + 0x00]
    movdqu xmm1, [rsp + 0x10]
    movdqu xmm2, [rsp + 0x20]
    movdqu xmm3, [rsp + 0x30]
    movdqu xmm4, [rsp + 0x40]
    movdqu xmm5, [rsp + 0x50]
    movdqu xmm6, [rsp + 0x60]
    movdqu xmm7, [rsp + 0x70]
    movdqu xmm8, [rsp + 0x80]
    movdqu xmm9, [rsp + 0x90]
    movdqu xmm10, [rsp + 0xA0]
    movdqu xmm11, [rsp + 0xB0]
    movdqu xmm12, [rsp + 0xC0]
    movdqu xmm13, [rsp + 0xD0]
    movdqu xmm14, [rsp + 0xE0]
    movdqu xmm15, [rsp + 0xF0]
    add rsp, 0x100
    pop r15
    pop r14
    pop r13
    pop r12
    pop rbp
    pop rbx

    ; IRQ1 (teclado): le o scancode e empilha no ring buffer — EXCETO quando
    ; um port driver nativo (i8042prt) conectou o vetor: o ISR nativo e' quem
    ; le a porta 0x60 (byte de controle em 0x81510, ver ke/interrupt-object.js)
    cmp edi, 0x21
    jne .no_key
    cmp byte [0x81510], 0
    jne .no_key
    in al, 0x60
    mov ecx, [KBD_HEAD]
    mov edx, ecx
    inc edx
    and edx, 0xFF
    cmp edx, [KBD_TAIL]
    je .no_key                            ; cheio: descarta
    mov [KBD_DATA + rcx], al
    mov [KBD_HEAD], edx
.no_key:
    ; EOI: vetores >= 0x40 sao do LAPIC (timer etc.) — EOI no LAPIC
    cmp edi, 0x40
    jb .pic_eoi
    mov eax, LAPIC_EOI
    mov dword [rax], 0
    jmp .eoi_done
.pic_eoi:
    ; EOI: IRQs 8-15 (vetores 0x28+) tambem no slave
    cmp edi, 0x28
    jb .master_only
    mov al, 0x20
    out 0xA0, al
.master_only:
    mov al, 0x20
    out 0x20, al                          ; EOI PIC master
.eoi_done:
    pop r11
    pop r10
    pop r9
    pop r8
    pop rdi
    pop rsi
    pop rdx
    pop rcx
    pop rax
    add rsp, 8                            ; descarta o vetor empilhado
    iretq
