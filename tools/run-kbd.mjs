#!/usr/bin/env node
/*
 * run-kbd.mjs - boot INTERATIVO do jsOS para testar o teclado real
 * (i8042prt.sys + kbdclass.sys da Microsoft) digitando de verdade.
 *
 * Abre o QEMU com uma JANELA (display default) — o que voce digita nela vai
 * para o teclado PS/2 do convidado — e o serial no console, onde cada tecla
 * que o driver real entrega aparece como "[kbdecho] MakeCode=0x..".
 *
 * Uso: node tools/run-kbd.mjs   (feche a janela do QEMU para sair)
 */
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qemu = process.env.QEMU || 'C:/Program Files/qemu/qemu-system-x86_64.exe';
const marker = path.join(root, 'apps', 'kbdecho');

// 1. marcador do modo eco + build (depois remove p/ nao sujar builds normais)
writeFileSync(marker, 'eco de teclado interativo\n');
let build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')],
                      { stdio: 'inherit' });
try { rmSync(marker); } catch {}
if (build.status !== 0) {
    console.error('build falhou');
    process.exit(build.status || 1);
}
if (!existsSync(path.join(root, 'build', 'os.img'))) {
    console.error('os.img nao gerado');
    process.exit(1);
}

// 2. QEMU com janela (o teclado da janela vira o PS/2 do convidado) + serial
const args = [
    '-accel', 'whpx',
    '-machine', 'pc,kernel-irqchip=off',
    '-m', '4096',
    '-smp', '4',
    '-drive', `format=raw,file=${path.join(root, 'build', 'os.img')}`,
    '-drive', `format=raw,if=ide,index=1,media=disk,file=${path.join(root, 'build', 'ntfs.img')}`,
    '-serial', 'stdio',
    // sem '-display none': abre a janela default — DIGITE NELA
];
console.log('Abrindo o QEMU — DIGITE na janela que abrir.');
console.log('Cada tecla entregue pelo driver real aparece abaixo como [kbdecho].\n');
const proc = spawn(qemu, args, { stdio: 'inherit' });
proc.on('exit', (code) => process.exit(code ?? 0));
