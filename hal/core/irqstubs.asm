; ---------------------------------------------------------------------------
; irqstubs.asm - trampolins de interrupcao (hardware exige codigo de maquina
; no vetor da IDT; a LOGICA toda fica no JavaScript).
;
; Cada stub: marca o vetor em edi, salva os registradores, registra o evento
; na memoria compartilhada (leitura pelo JS via os.readPhysical*), faz EOI no
; PIC, restaura e iretq. Nao chama C nem JS (seguro em contexto de IRQ).
;
; Mapa de memoria fisica compartilhada:
;   0x81000: u32 irq_count[48]        (contagem de interrupcoes por vetor)
;   0x81100: ring buffer do teclado   (head u32 @0x81100, tail u32 @0x81104,
;                                      dados 256B @0x81108)
; ---------------------------------------------------------------------------
[bits 64]

%define NSTUBS      48
%define IRQ_COUNT   0x81000
%define KBD_HEAD    0x81100
%define KBD_TAIL    0x81104
%define KBD_DATA    0x81108

global irq_stub_table

align 16
irq_stub_table:
%assign i 0
%rep NSTUBS
    mov edi, i              ; 5 bytes
    jmp irq_common          ; 5 bytes -> stub = 10 bytes
%assign i i+1
%endrep

align 16
irq_common:
    push rax
    push rcx
    push rdx
    push rsi
    push r8
    push r9
    push r10
    push r11

    ; irq_count[edi]++
    mov eax, IRQ_COUNT
    inc dword [rax + rdi*4]

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
    ; EOI: IRQs 8-15 (vetores 0x28+) tambem no slave
    cmp edi, 0x28
    jb .master_only
    mov al, 0x20
    out 0xA0, al
.master_only:
    cmp edi, 0x20
    jb .no_irq                            ; excecoes (0-31) nao levam EOI
    mov al, 0x20
    out 0x20, al                          ; EOI PIC master
.no_irq:
    pop r11
    pop r10
    pop r9
    pop r8
    pop rsi
    pop rdx
    pop rcx
    pop rax
    iretq
