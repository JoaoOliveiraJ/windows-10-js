#!/usr/bin/env node
/*
 * build.mjs - build completo do jsOS (boot BIOS bare metal, sem UEFI):
 *  1. gera build/generated/jsbundle.c a partir de js/ + apps/
 *  2. nasm: boot/boot.asm -> build/boot.bin (512B), boot/stage2.asm -> stage2
 *  3. zig cc: host layer C + QuickJS -> build/kernel.elf; objcopy -> .bin
 *  4. monta os.img: [setor 0: boot][LBA 1..64: stage2][LBA 65+: kernel]
 *     e grava o numero de setores do kernel no header do stage2 (offset 3)
 *
 * Uso: node tools/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zig = path.join(root, 'tools', 'zig', process.platform === 'win32' ? 'zig.exe' : 'zig');
const nasm = process.env.NASM || 'C:/Program Files/NASM/nasm.exe';
const buildDir = path.join(root, 'build');

const STAGE2_MAX = 64 * 512;      /* reserva do stage2 na imagem (LBA 1..64) */
const KERNEL_MAX = 1536 * 1024;   /* kernel max: 1.5MB (stack em 3MB) */

function walk(dir, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out.sort();
}

function run(cmd, args) {
    try {
        execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        process.stderr.write(e.stderr ? e.stderr.toString() : String(e));
        console.error(`\nFALHA: ${path.basename(cmd)} ${args.join(' ')}`);
        process.exit(1);
    }
}

function pad512(buf) {
    const pad = (512 - (buf.length % 512)) % 512;
    return pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf;
}

/* ---- 1. bundle embutido (js/ + apps/) ---- */

function cEscape(buf) {
    // octal de 3 digitos: unico escape C sem ambiguidade para dados binarios
    let s = '';
    for (const b of buf) {
        if (b === 0x5c) s += '\\\\';
        else if (b === 0x22) s += '\\"';
        else if (b === 0x0a) s += '\\n';
        else if (b === 0x0d) s += '\\r';
        else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
        else s += '\\' + b.toString(8).padStart(3, '0');
    }
    return s;
}

function genBundle() {
    const genDir = path.join(buildDir, 'generated');
    mkdirSync(genDir, { recursive: true });
    const entries = [];
    for (const [dir, prefix] of [[path.join(root, 'system32'), 'system32/'], [path.join(root, 'apps'), 'apps/']]) {
        for (const f of walk(dir)) {
            const rel = path.relative(dir, f).split(path.sep).join('/');
            if (prefix && f.endsWith('.c')) continue;   // fontes de apps/win nao entram
            entries.push({ name: prefix + rel, file: f });
        }
    }
    /* .exe Windows compilado pelo build (ver secao 0) */
    const helloExe = path.join(buildDir, 'hello.exe');
    if (existsSync(helloExe)) entries.push({ name: 'apps/hello.exe', file: helloExe });
    /* driver .sys compilado pelo build (ver secao 0b) */
    const echoSys = path.join(buildDir, 'echo.sys');
    if (existsSync(echoSys)) entries.push({ name: 'apps/echo.sys', file: echoSys });
    let out = '/* GERADO pelo build (tools/build.mjs) - nao editar */\n';
    out += '#include <stdint.h>\n';
    out += 'typedef struct { const char *name; const char *data; uint32_t size; } jsbundle_file_t;\n\n';
    entries.forEach((e, i) => {
        out += `static const char jsf_${i}[] = "${cEscape(readFileSync(e.file))}";\n`;
    });
    out += '\nconst jsbundle_file_t jsbundle_files[] = {\n';
    entries.forEach((e, i) => {
        out += `    { "${e.name}", jsf_${i}, sizeof(jsf_${i}) - 1 },\n`;
    });
    out += '};\n';
    out += `const uint32_t jsbundle_count = ${entries.length};\n`;
    writeFileSync(path.join(genDir, 'jsbundle.c'), out);
    return entries.length;
}

/* ---- 2/3/4. bootloader, kernel C, imagem ---- */

mkdirSync(buildDir, { recursive: true });

/* 0. demo Windows .exe (PE32+) compilado com zig cc */
const helloC = path.join(root, 'apps', 'win32-demo', 'hello.c');
if (existsSync(helloC)) {
    run(zig, ['cc', '-target', 'x86_64-windows-gnu', '-nostdlib', '-O2',
        '-Wl,-e,mainCRTStartup', '-Wl,--subsystem,console', '-Wl,--image-base,0x400000',
        helloC, '-lkernel32', '-o', path.join(buildDir, 'hello.exe')]);
}

/* 0b. driver demo .sys (PE nativo, imports de ntoskrnl.exe).
 * zig dlltool gera a import library a partir do .def. */
const echoDriverC = path.join(root, 'apps', 'drivers', 'echo.c');
if (existsSync(echoDriverC)) {
    const defFile = path.join(buildDir, 'ntoskrnl.def');
    writeFileSync(defFile,
        'LIBRARY ntoskrnl.exe\nEXPORTS\n' +
        ['DbgPrint', 'IoCreateDevice', 'IoCreateSymbolicLink', 'IoDeleteDevice',
         'RtlInitUnicodeString', 'IoCompleteRequest'].join('\n') + '\n');
    run(zig, ['dlltool', '-d', defFile, '-l', path.join(buildDir, 'ntoskrnl.lib')]);
    run(zig, ['cc', '-target', 'x86_64-windows-gnu', '-nostdlib', '-O2',
        '-Wl,-e,DriverEntry', '-Wl,--subsystem,native', '-Wl,--image-base,0x500000',
        echoDriverC, path.join(buildDir, 'ntoskrnl.lib'),
        '-o', path.join(buildDir, 'echo.sys')]);
}

const nFiles = genBundle();

/* disco NTFS de teste (anexado como slave IDE no QEMU) */
run('python', [path.join(root, 'tools', 'mkntfs.py'), path.join(buildDir, 'ntfs.img')]);

const bootBin = path.join(buildDir, 'boot.bin');
const stage2Bin = path.join(buildDir, 'stage2.bin');
run(nasm, ['-f', 'bin', path.join(root, 'boot', 'boot.asm'), '-o', bootBin]);
run(nasm, ['-f', 'bin', path.join(root, 'boot', 'stage2.asm'), '-o', stage2Bin]);

const boot = readFileSync(bootBin);
let stage2 = readFileSync(stage2Bin);
if (boot.length !== 512) { console.error(`boot.bin com ${boot.length} bytes (esperado 512)`); process.exit(1); }
if (stage2.length > STAGE2_MAX) { console.error('stage2.bin maior que a reserva de 32KB'); process.exit(1); }

/* trampolins Win32 (ABI MS -> SysV -> JS) */
const thunkObj = path.join(buildDir, 'win32thunk.o');
run(nasm, ['-f', 'elf64', path.join(root, 'hal', 'win32', 'win32thunk.asm'), '-o', thunkObj]);

/* trampolins de IRQ (vetores -> memoria compartilhada, lida pelo JS) */
const irqObj = path.join(buildDir, 'irqstubs.o');
run(nasm, ['-f', 'elf64', path.join(root, 'hal', 'core', 'irqstubs.asm'), '-o', irqObj]);

const sources = new Set([
    ...walk(path.join(root, 'hal')).filter(f => f.endsWith('.c')),
    path.join(buildDir, 'generated', 'jsbundle.c'),
    thunkObj,
    irqObj,
]);

const quickjsHost = path.join(root, 'hal', 'qjs', 'engine.c');
const withQuickJS = existsSync(quickjsHost);
if (withQuickJS) {
    const vq = path.join(root, 'vendor', 'quickjs');
    for (const f of ['quickjs.c', 'libregexp.c', 'libunicode.c', 'cutils.c', 'dtoa.c'])
        sources.add(path.join(vq, f));
    const vm = path.join(root, 'vendor', 'musl-math');
    for (const f of [
        'fabs.c', 'floor.c', 'ceil.c', 'trunc.c', 'round.c', 'nearbyint.c', 'rint.c',
        'lrint.c', 'llrint.c', 'fmod.c', 'sqrt.c', 'cbrt.c', 'pow.c', 'exp.c',
        'expm1.c', 'exp2.c', 'log.c', 'log2.c', 'log10.c', 'log1p.c', 'modf.c',
        'sin.c', 'cos.c', 'tan.c', 'asin.c', 'acos.c', 'atan.c', 'atan2.c',
        'sinh.c', 'cosh.c', 'tanh.c', 'asinh.c', 'acosh.c', 'atanh.c',
        'hypot.c', 'fmax.c', 'fmin.c', 'copysign.c', 'scalbn.c', 'frexp.c', 'ldexp.c',
        '__rem_pio2.c', '__rem_pio2_large.c', '__sin.c', '__cos.c', '__tan.c', '__expo2.c',
        '__math_divzero.c', '__math_invalid.c', '__math_oflow.c', '__math_uflow.c', '__math_xflow.c',
        '__fpclassify.c', '__signbit.c',
        'exp_data.c', 'log_data.c', 'log2_data.c', 'pow_data.c', 'sqrt_data.c',
    ]) sources.add(path.join(vm, f));
}

const qjsVersion = readFileSync(path.join(root, 'vendor', 'quickjs', 'VERSION'), 'utf8').trim();

const elf = path.join(buildDir, 'kernel.elf');
const kbin = path.join(buildDir, 'kernel.bin');
run(zig, [
    'cc',
    '-target', 'x86_64-freestanding-none',
    '-std=gnu11', '-O2',
    '-ffreestanding', '-nostdlib',
    '-fno-lto', '-fno-sanitize=all',
    '-fno-stack-protector', '-fno-stack-check', '-fno-builtin',
    '-fno-unwind-tables', '-fno-asynchronous-unwind-tables',
    '-mno-red-zone',
    '-Wall',
    '-I', path.join(root, 'hal', 'core'),
    '-I', path.join(root, 'hal', 'rtl', 'include'),
    '-I', path.join(root, 'vendor', 'quickjs'),
    '-Dhidden=',
    `-DCONFIG_VERSION="${qjsVersion}"`,
    ...[...sources],
    '-Wl,--no-gc-sections',
    '-Wl,-T,' + path.join(root, 'hal', 'core', 'link.ld'),
    '-Wl,--build-id=none',
    '-o', elf,
]);
run(zig, ['objcopy', '-O', 'binary', elf, kbin]);

let kernel = readFileSync(kbin);
if (kernel.length > KERNEL_MAX) { console.error(`kernel.bin com ${kernel.length} bytes (max ${KERNEL_MAX})`); process.exit(1); }

kernel = pad512(kernel);
const kernelSectors = kernel.length / 512;
stage2.writeUInt16LE(kernelSectors, 3);           /* offset 3: campo kernel_sectors */
stage2 = Buffer.concat([stage2, Buffer.alloc(STAGE2_MAX - stage2.length)]);

writeFileSync(path.join(buildDir, 'os.img'), Buffer.concat([boot, stage2, kernel]));

console.log(`OK: build/os.img  (kernel ${kernel.length}b/${kernelSectors} setores, bundle ${nFiles} arquivos${withQuickJS ? ', QuickJS' : ''})`);
