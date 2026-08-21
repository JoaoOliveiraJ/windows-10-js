# windows-10-js (jsOS)

**Kernel bare metal escrito em JavaScript**, com arquitetura inspirada no
Windows NT — boota de verdade (BIOS → real mode → protected mode → long mode
64-bit) e executa até `.exe` Windows (PE32+) nativamente, com o loader e o
mini-kernel32 em JS.

![screenshot](docs/shot.png)

## Por que existe um pouco de C e Assembly?

A CPU x86-64 só executa código de máquina — não existe boot "100% JS" no
hardware. Então existe uma **camada hospedeira fixa, escrita uma vez**, e o
sistema operacional de verdade (tudo que você edita e evolui) é JavaScript:

| Camada | Linguagem | O que faz |
|---|---|---|
| Boot (real mode → long mode) | Assembly | setor de boot, E820, A20, GDT, carga do kernel via ATA PIO, paginação, SSE |
| Motor + primitivas | C | engine **QuickJS** + `os.*` (portas de I/O, peek/poke de memória física, heap, bundle de arquivos) |
| **Sistema operacional** | **JavaScript** | drivers VGA/teclado, console, shell, syscalls, VFS, escalonador, memória |

É a mesma relação que o Node.js (C++) tem com o seu código JS — só que aqui o
C++ não tem sistema operacional embaixo: é bare metal.

## Estrutura

Espelha a arvore-fonte do Windows NT (WRK): `boot/`, `hal/`, `system32/`
com `ntos/{ob,mm,ps,ex,fs,rtl,test}`, `drivers/`, `win32/`.

```
├── boot/                     # Assembly: boot.asm (setor 512B) + stage2.asm
│                             #   (real→prot→long mode, E820, ATA PIO, paging)
├── hal/                      # HAL + engine host (camada C fixa, minima)
│   ├── core/                 #   kernel_main.c, host.c/h, drivers.h, link.ld
│   ├── mm/                   #   kmalloc.c (heap K&R; inicio 16MB)
│   ├── rtc/                  #   rtc.c (relogio CMOS p/ Date do engine)
│   ├── qjs/                  #   quickjs_host.c/h (contexto QuickJS + os.*)
│   ├── win32/                #   win32thunk.asm (ABI MS x64 → SysV → JS)
│   └── rtl/                  #   libc shim minimo (exigido pelo engine)
├── system32/                 # ★ O SISTEMA — 100% JavaScript ★
│   ├── main.js               #   entry: raiz de composicao (monta o SO)
│   ├── ntos/                 #   nucleo (≈ ntoskrnl.exe)
│   │   ├── ob/objmgr.js      #     Object Manager (namespace, handles)
│   │   ├── mm/memory.js      #     Memory Manager (visao heap/RAM)
│   │   ├── ps/scheduler.js   #     Process Manager (escalonador)
│   │   ├── ex/syscalls.js    #     Executive: tabela de syscalls
│   │   ├── fs/vfs.js         #     VFS (FS em memoria)
│   │   ├── rtl/module.js     #     runtime: mini CommonJS require()
│   │   └── test/selftest.js  #     autoteste (marca SELFTEST_OK)
│   ├── drivers/              #   drivers (≈ System32\drivers)
│   │   ├── video/vga.js      #     VGA 80x25 (poke16 em 0xB8000)
│   │   ├── input/keyboard.js #     teclado PS/2 por polling (inb 0x60)
│   │   └── console/console.js#     console (VGA + serial)
│   ├── win32/                #   subsistema Win32
│   │   ├── pe.js             #     loader PE32+ (parse, secoes, IAT)
│   │   └── win32.js          #     mini-kernel32 (GetStdHandle, WriteFile...)
│   └── shell/shell.js        #   o "cmd.exe" do jsOS
├── apps/                     # programas do VFS (≈ Program Files)
│   └── win/hello.c           #   fonte do hello.exe (demo .exe Windows)
├── vendor/                   # quickjs (engine) + musl-math (libm, MIT)
├── tools/                    # build.mjs, test-boot.mjs, run.bat, zig/
├── docs/                     # screenshots
├── build/                    # TUDO gerado (kernel.elf, os.img, hello.exe)
└── README.md
```

## Primitivas `os.*` (a única porta do JS para o hardware)

| Função | Descrição |
|---|---|
| `os.print(...)` | saída na serial COM1 (debug, com newline) |
| `os.write(s)` | serial crua, sem newline |
| `os.outb(port, v)` / `os.inb(port)` | I/O de porta (drivers em JS usam isso) |
| `os.poke8/16/32(addr, v)` / `os.peek8/16/32(addr)` | memória física (identity-mapped) |
| `os.readFile(nome)` / `os.readFileBytes(nome)` | arquivo do bundle (texto / ArrayBuffer) |
| `os.listBundle()` | nomes dos arquivos embutidos |
| `os.execAt(addr)` | chama código nativo x86-64 (entry de .exe) |
| `os.win32ThunkBase()` | base da tabela de trampolins Win32 |
| `os.ramSize()` / `os.heapInfo()` | RAM (E820) / uso do heap |
| `os.halt()` | desliga |

## Arquitetura estilo Windows NT (em construção)

O jsOS espelha a arquitetura do Windows NT, com cada camada em JS:

| Windows NT | jsOS | Módulo |
|---|---|---|
| HAL | primitivas de hardware | `hal/` C + `system32/drivers/` |
| tabela de serviços | syscalls numeradas | `system32/ntos/ex/syscalls.js` |
| **Object Manager** | namespace único, handles, refcount | `system32/ntos/ob/objmgr.js` ✅ |
| Process Manager | escalonador cooperativo | `system32/ntos/ps/scheduler.js` |
| I/O Manager (IRP) | — | próximo passo |
| Config Manager (Registry) | — | depois |
| subsistema Win32 | mini-kernel32 + loader PE | `system32/win32/` |
| ntdll (stubs user mode) | função `SYS()` | informal |

O Object Manager (`ob/objmgr.js`) é a fundação NT: **tudo é objeto** —
diretórios, arquivos, dispositivos, links simbólicos — num namespace único
case-insensitive, aberto por handle com contagem de referência:

```
\                               [Directory]
├── \FS  (mount → VFS)          [Directory, mount]  ← \FS\README vira File
├── \Device                     [Directory]
│   ├── \Device\Console         [Device]
│   └── \Device\Keyboard        [Device]
└── \DosDevices                 [Directory]
    └── \DosDevices\C:          [SymbolicLink → \FS]   ← como no NT de verdade
```

Syscalls novas: `open`=11, `close`=12. No shell, `objects` mostra a árvore e
caminhos `C:\arquivo` funcionam (o shell traduz para o VFS; o namespace NT
resolve `\DosDevices\C:\...` seguindo o link).

Roadmap NT: Fase A ✅ Object Manager → Fase B: I/O Manager (DriverObject /
DeviceObject + IRPs descendo pela pilha) → Fase C: processos como objetos com
handles → Fase D: Registry-like em JS → Fase E: camada user-mode (ntdll-like).

## Sistema de módulos em JS

Todo subsistema é um **módulo CommonJS exportável** — `ntos/rtl/module.js`
implementa `require()` lendo do bundle embutido (raiz: `system32/`). Você monta
e estende o sistema em `system32/main.js` só com JavaScript:

```js
const require = JSOS.require;
const VFS       = require('ntos/fs/vfs');
const Scheduler = require('ntos/ps/scheduler');
const VGA       = require('drivers/video/vga');
// seu modulo novo: system32/ntos/ex/meu_modulo.js com module.exports = {...}
```

Nada de globals soltos: cada arquivo tem `module.exports` e declara suas
dependências com `require('...')`.

## Compatibilidade com Windows (.exe)

O jsOS **executa .exe Windows (PE32+, console, x86-64) nativamente**, com o
loader e a API em JavaScript:

- `system32/win32/pe.js` — faz o parse do PE, mapeia seções na memória física
  no ImageBase preferido (`0x400000`) e resolve a IAT (imports por nome de
  `KERNEL32.dll`) apontando para os trampolins de `hal/win32/win32thunk.asm`.
- `hal/win32/win32thunk.asm` — converte a ABI Microsoft x64 → SysV e despacha.
- `hal/qjs/quickjs_host.c: js_win32_dispatch` — chama o handler JS.
- `system32/win32/win32.js` — as APIs Windows em si (hoje: `GetStdHandle`,
  `WriteFile`, `ExitProcess`, `GetTickCount`), implementadas sobre syscalls do jsOS.

Demo: `exec /hello.exe` no shell (ou rode o autoteste) — um `.exe` compilado
para Windows roda no metal e imprime via "kernel32" em JS. Fonte em
`apps/win/hello.c`, compilado no build com `zig cc -target x86_64-windows-gnu`.

**Limites honestos**: para rodar programas Windows maiores (CRT do mingw/msvc,
GUI, threads, DLLs) seria preciso implementar centenas de APIs e o formato de
exceções SEH — é o escopo do ReactOS (décadas de trabalho). O caminho é
expandir `win32.js` API a API.

## E drivers .sys do Windows?

**Não é viável** — drivers WDM dependem do ntoskrnl, HAL, I/O Manager, PnP,
Registry e dezenas de subsistemas com semântica exata do Windows NT; é a parte
mais difícil do ReactOS. O jsOS tem seu próprio modelo de drivers **em
JavaScript** (`system32/drivers/video/vga.js`, `input/keyboard.js` são drivers
de verdade, falando com hardware via `os.inb/outb/poke`), que é o caminho
sustentável para este projeto crescer.

## Build e execução

Pré-requisitos: NASM, Node.js, Python (para conversões), QEMU em
`C:\Program Files\qemu`. O Zig é baixado automaticamente em `tools/zig` pelo
build (única dependência de toolchain, portátil).

```bat
node tools\build.mjs        :: compila tudo e gera build\os.img
tools\run.bat               :: boot interativo (janela VGA, aceleração WHPX)
node tools\test-boot.mjs    :: boot headless; PASS se SELFTEST_OK no serial
```

O teste headless sobe a VM, o kernel JS roda o autoteste (VFS, syscalls,
execução de programa do VFS, escalonador) e imprime `SELFTEST_OK` na serial.

## Como o kernel JS funciona

- `js/main.js` é embutido no kernel pelo build (bundle `src/generated/jsbundle.c`)
  e executado após o boot. Para editar o sistema: mexa em `js/`, rode
  `node tools\build.mjs` de novo.
- **Processos** são funções geradoras (`function*`) cooperativas: cada `yield`
  devolve a CPU ao escalonador. O shell é o processo 1. `spawn /pisca.js` no
  shell cria um segundo processo; `ps` lista; `kill <pid>` mata.
- **Syscalls numeradas** (`SYS(num, ...)`): print=0, read=1, write=2, list=3,
  remove=4, exists=5, meminfo=6, getchar=7, clear=8, halt=9, ramsize=10.
  Programas JS do VFS (`run /hello.js`) recebem `SYS` como argumento — nunca
  tocam `os.*` direto.
- **VFS** em memória com namespace plano (`/README`, `/hello.js`, ...).

## Marcadores de boot (serial COM1)

`B E A P K G L 6` = stage2 progredindo (real→prot→ATA→paginação→long mode);
`HELLO_KERNEL_OK` = host C vivo; `KERNEL_JS_OK` = main.js executando;
`SELFTEST_OK` = autoteste passou.

## Roadmap (próximos passos possíveis)

- IDT própria + IRQ1 de teclado (hoje o teclado é polling 100% JS)
- Persistência: driver ATA PIO em JS + FS simples em setores do disco
- Timer IRQ0 → escalonador preemptivo (troca de contexto real)
- Modo gráfico (VBE/framebuffer) e desktop em JS
