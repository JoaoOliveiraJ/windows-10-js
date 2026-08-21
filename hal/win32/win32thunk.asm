; ---------------------------------------------------------------------------
; win32thunk.asm - trampolins Win32/ntoskrnl (ABI Microsoft x64 -> SysV -> JS)
; + exec_msabi (chama codigo nativo MS ABI a partir do kernel SysV).
;
; A IAT de um PE carregado (.exe ou .sys) e preenchida com enderecos destes
; stubs. Cada stub marca seu id e cai no trampolim comum, que traduz a ABI MS
; (rcx,rdx,r8,r9) para SysV e chama js_win32_dispatch(id, a1..a4) em C, que
; despacha para o handler JavaScript (win32.js / ntoskrnl.js).
;
; Convencao de ids: 0-31 = kernel32 (win32.js), 32-63 = ntoskrnl (exports do
; kernel para drivers .sys).
; ---------------------------------------------------------------------------
[bits 64]

extern js_win32_dispatch
global win32_stubs
global exec_msabi

%define MAX_WIN32 64

align 16
win32_stubs:
%assign i 0
%rep MAX_WIN32
    mov eax, i                  ; 5 bytes
    jmp strict near win32_common       ; 5 bytes (E9 rel32 FORCADO: stub = 10 bytes)
%assign i i+1
%endrep

align 16
win32_common:
    ; entrada: rax = id; rcx,rdx,r8,r9 = args 1-4; args 5-7 na pilha do
    ; convidado (apos o shadow space): [rsp+40]=a5, [rsp+48]=a6, [rsp+56]=a7
    push rbp
    mov rbp, rsp
    ; MS ABI trata rsi/rdi/rbx/r12-r15 como nao-volateis (callee-saved);
    ; o C SysV poderia destrui-los - salvar todos antes da chamada
    push rbx
    push rsi
    push rdi
    push r12
    push r13
    push r14
    push r15
    and rsp, -16

    ; SysV: rdi=id rsi=a1 rdx=a2 rcx=a3 r8=a4 r9=a5, pilha: a6, a7
    mov rdi, rax                ; id
    mov rsi, rcx                ; a1
    ; rdx = a2 (inalterado)
    mov rcx, r8                 ; a3
    mov r8, r9                  ; a4
    mov r9, [rbp + 48]          ; a5 (pilha do convidado)
    mov rax, [rbp + 64]         ; a7
    push rax                    ; push arg8 primeiro
    mov rax, [rbp + 56]         ; a6
    push rax                    ; depois arg7 -> [rsp]=a6 na entrada do callee

    call js_win32_dispatch
    add rsp, 16

    lea rsp, [rbp - 56]         ; descarta o alinhamento, volta aos regs salvos
    pop r15
    pop r14
    pop r13
    pop r12
    pop rdi
    pop rsi
    pop rbx
    pop rbp
    ret                         ; retorno em rax vale para o convidado

; ---------------------------------------------------------------------------
; exec_msabi(addr, a1, a2): chama codigo nativo MS ABI (DriverEntry e
; dispatch routines de drivers .sys) a partir do kernel (SysV).
;   SysV entrada: rdi = endereco, rsi = arg1, rdx = arg2
;   MS ABI:       rcx = arg1,   rdx = arg2  (+32B de shadow space)
;   Retorno em rax e repassado ao chamador SysV.
; ---------------------------------------------------------------------------
align 16
exec_msabi:
    push rbp
    mov rbp, rsp
    mov rcx, rsi                ; arg1
    ; rdx ja e' arg2 (mesmo registrador nas duas ABIs)
    mov rax, rdi                ; endereco
    and rsp, -16
    sub rsp, 32                 ; shadow space da MS ABI
    call rax
    mov rsp, rbp
    pop rbp
    ret
