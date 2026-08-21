; ---------------------------------------------------------------------------
; win32thunk.asm - trampolins Win32 (ABI Microsoft x64 -> SysV -> JS).
;
; A IAT de um .exe carregado e preenchida com enderecos destes stubs.
; Cada stub marca seu id e cai no trampolim comum, que traduz a ABI MS
; (rcx,rdx,r8,r9) para SysV e chama js_win32_dispatch(id, a1..a4) em C,
; que despacha para o handler JavaScript (js/kernel/win32.js).
; ---------------------------------------------------------------------------
[bits 64]

extern js_win32_dispatch
global win32_stubs

%define MAX_WIN32 64

align 16
win32_stubs:
%assign i 0
%rep MAX_WIN32
    mov eax, i                  ; 5 bytes
    jmp win32_common            ; 5 bytes (rel32) - stub = 10 bytes
%assign i i+1
%endrep

align 16
win32_common:
    ; na entrada: rax = id da API; rcx,rdx,r8,r9 = args do convidado (MS ABI)
    push rbp
    mov rbp, rsp
    and rsp, -16

    ; SysV: rdi=id, rsi=a1, rdx=a2, rcx=a3, r8=a4
    mov rdi, rax
    mov rsi, rcx
    mov rcx, r8
    mov r8, r9
    ; rdx ja contem a2

    call js_win32_dispatch

    mov rsp, rbp
    pop rbp
    ret                         ; retorno em rax vale para o convidado
