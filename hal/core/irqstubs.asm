; ---------------------------------------------------------------------------
; irqstubs.asm - trampolins de interrupcao (hardware exige codigo de maquina
; no vetor da IDT; a LOGICA toda fica no JavaScript).
;
; Cada stub: marca o vetor em edi, salva os registradores, registra o evento
; na memoria compartilhada (leitura pelo JS via os.readPhysical*), faz EOI no
; PIC, restaura e iretq. Nao chama C nem JS (seguro em contexto de IRQ).
;
; Mapa de memoria fisica compartilhada:
;   0x81000: u32 irq_count[80]        (contagem de interrupcoes por vetor)
;   0x81200: ring buffer do teclado   (head u32 @0x81200, tail u32 @0x81204,
;                                      dados 256B @0x81208)
; ---------------------------------------------------------------------------
[bits 64]

%define NSTUBS      80
%define IRQ_COUNT   0x81000
%define KBD_HEAD    0x81200
%define KBD_TAIL    0x81204
%define KBD_DATA    0x81208
%define LAPIC_EOI   0xFEE000B0

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
    mov edi, [rsp + 72]         ; vetor empilhado pelo stub (push byte i)

    ; irq_count[edi]++
    mov eax, IRQ_COUNT
    inc dword [rax + rdi*4]

    ; excecoes (vetores 0-31): NAO da p/ iret cego (voltaria na mesma
    ; instrucao que falhou). Diagnostico na serial e para a maquina.
    cmp edi, 0x20
    jae .is_irq
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
    ; RIP da falha: 9 pushes + vetor do stub + error code -> [rsp+88]
    mov r10, [rsp + 88]
    mov ecx, 16
.ripdig:
    rol r10, 4
    mov eax, r10d
    call .hexdig
    dec ecx
    jnz .ripdig
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
    ; IRQ1 (teclado): le o scancode e empilha no ring buffer
    cmp edi, 0x21
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
