#!/usr/bin/env node
/*
 * run-kbd.mjs - boot INTERATIVO p/ testar o teclado real (i8042prt + kbdclass).
 *
 * Abre o QEMU com uma JANELA (sdl) — voce digita nela. O serial NAO vai p/ o
 * console (para nao poluir): vai p/ build/kbd-log.txt, que eu analiso depois.
 *
 * Uso: node tools/run-kbd.mjs   (digite na janela, feche o QEMU p/ sair)
 */
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qemu = process.env.QEMU || 'C:/Program Files/qemu/qemu-system-x86_64.exe';
const marker = path.join(root, 'apps', 'kbdecho');
const logFile = path.join(root, 'build', 'kbd-log.txt');

// 1. marcador do modo eco + build (depois remove p/ nao sujar builds normais)
writeFileSync(marker, 'eco de teclado interativo\n');
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')],
                        { stdio: 'inherit' });
try { rmSync(marker); } catch {}
if (build.status !== 0) { console.error('build falhou'); process.exit(build.status || 1); }
if (!existsSync(path.join(root, 'build', 'os.img'))) { console.error('sem os.img'); process.exit(1); }

// 2. serial -> build/kbd-log.txt (limpa o arquivo antes)
writeFileSync(logFile, '');
const logStream = createWriteStream(logFile, { flags: 'a' });

const args = [
    '-accel', 'whpx',
    '-machine', 'pc,kernel-irqchip=off',
    '-m', '4096',
    '-smp', '4',
    '-drive', `format=raw,file=${path.join(root, 'build', 'os.img')}`,
    '-drive', `format=raw,if=ide,index=1,media=disk,file=${path.join(root, 'build', 'ntfs.img')}`,
    '-display', 'sdl',
    '-serial', 'stdio',
];
console.log('Abrindo o QEMU — DIGITE na janela que abrir.');
console.log('O serial esta sendo salvo em build\\kbd-log.txt (console limpo).');
console.log('Quando terminar de digitar, FECHE o QEMU. Depois me diga o que viu.\n');
const proc = spawn(qemu, args, { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', (d) => logStream.write(d));
proc.stderr.on('data', (d) => logStream.write(d));
proc.on('exit', () => {
    logStream.end();
    console.log('\nQEMU fechado. Log salvo em build\\kbd-log.txt — me pede p/ analisar.');
});
