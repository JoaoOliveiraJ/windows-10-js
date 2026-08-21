# Arquitetura do jsOS (nanokernel)

## Visão em camadas

```
┌─────────────────────────────────────────────────────────────┐
│ APLICAÇÕES — programas JS do VFS, shell, .exe PE (Win32)    │
├─────────────────────────────────────────────────────────────┤
│ SUBSISTEMAS NT (system32/ntos/)                             │
│   ob/  Object Manager — namespace único, handles, refcount  │
│   io/  I/O Manager — DriverObject/DeviceObject + IRPs       │
│   ps/  Process Manager — escalonador cooperativo (geradores)│
│   mm/  Memory Manager — visão heap/RAM                      │
│   ex/  Executive — tabela de syscalls numeradas             │
│   fs/  vfs.js (RAM) + ntfs.js (NTFS real, leitura)          │
│   rtl/ module.js — mini CommonJS (require)                  │
├─────────────────────────────────────────────────────────────┤
│ NANOKERNEL (system32/nano/) — o núcleo mínimo               │
│   irq.js    — interrupções: IDT construída em JS na memória │
│               física, PIC/PIT programados pelas portas      │
│   ipc.js    — canais nomeados de mensagens entre serviços   │
│   kernel.js — registro/chamada de serviços                  │
├─────────────────────────────────────────────────────────────┤
│ DRIVERS (system32/drivers/) — JS, com DriverEntry estilo NT │
│   video/vga.js  input/keyboard.js  console/console.js       │
│   storage/atapio.js (disco ATA PIO)                         │
├─────────────────────────────────────────────────────────────┤
│ HAL + ENGINE (hal/, C — fixo, mínimo)                       │
│   core/   entry, serial, portas, heap inicial, link.ld      │
│           irqstubs.asm (trampolim de IRQ — lei do hardware) │
│   mm/ rtc/ win32/ (trampolim ABI MS→SysV)                   │
│   qjs/    engine QuickJS + primitivas os.*                  │
│           (divididas: engine.c, primitives_ports.c,         │
│            primitives_memory.c, primitives_system.c,        │
│            primitives_irq.c)                                │
│   rtl/    libc shim (exigência do engine)                   │
├─────────────────────────────────────────────────────────────┤
│ BOOT (boot/, asm) — setor 512B + real→prot→long mode        │
└─────────────────────────────────────────────────────────────┘
```

## O que é o "nanokernel" aqui

O núcleo faz o **mínimo**: interrupções (`nano/irq.js`), IPC (`nano/ipc.js`),
registro de serviços (`nano/kernel.js`) e escalonamento (`ntos/ps/`). Todo o
resto — drivers, filesystems, console, subsistema Win32 — são **módulos JS
componíveis** carregados com `require()` e, quando tocam hardware, registrados
como `DriverObject` no I/O Manager com dispatch por IRP.

Fluxo de uma tecla (exemplo real do nanokernel):

```
tecla → IRQ1 → trampolim asm (grava scancode no ring em 0x81100)
      → drivers/input/keyboard.js decodifica (pollKey)
      → processo kbd-service publica no canal IPC 'kbd'
      → shell consome com Ipc.receive('kbd')
```

## Por que existe C e Assembly (mínimos e fixos)

A CPU liga em real mode e interrupções exigem código de máquina no vetor —
não existe como fugir. Então o substrato é fixo e escrito uma vez:

- `boot/` — transição de modo (lei do hardware);
- `hal/` — o **engine** QuickJS (quem executa JS) + primitivas `os.*` de uma
  instrução cada (in/out/lidt/rdmsr/cpuid) + trampolins de ABI;
- **toda a lógica** — drivers, IDT, PIC, PIT, FS, processos, syscalls, IRPs —
  é JavaScript.

## Nota de plataforma (WHPX)

O QEMU/WHPX não entrega interrupções de PIC/LAPIC para kernels custom
(`wrmsr` no APIC derruba o VP; IRQs do PIC nunca chegam). O kernel detecta a
plataforma via CPUID e cai para **modo polling** automaticamente — tudo
funciona igual, só sem preempção por timer. Sob TCG (ou hardware real) as
interrupções completas ligam sozinhas (IDT+PIT+PIC ativos, teclado por IRQ1).
