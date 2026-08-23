#!/usr/bin/env node
/*
 * run-rawkbd.mjs - boot de DIAGNOSTICO do 8042 SEM driver nativo: isola se o
 * QEMU entrega tecla a um poller cru da porta 0x60. Se scancodes aparecerem ao
 * digitar, o QEMU entrega (e o problema e' o driver); se nao, e' o QEMU/WHPX.
 *
 * Uso: node tools/run-rawkbd.mjs   (digite na janela; feche p/ sair)
 */
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qemu = process.env.QEMU || 'C:/Program Files/qemu/qemu-system-x86_64.exe';
const marker = path.join(root, 'apps', 'rawkbd');

writeFileSync(marker, 'diagnostico cru do 8042\n');
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')],
                        { stdio: 'inherit' });
try { rmSync(marker); } catch {}
if (build.status !== 0) { console.error('build falhou'); process.exit(build.status || 1); }
if (!existsSync(path.join(root, 'build', 'os.img'))) { console.error('sem os.img'); process.exit(1); }

const args = [
    '-accel', 'whpx',
    '-machine', 'pc,kernel-irqchip=off',
    '-m', '4096',
    '-smp', '4',
    '-drive', `format=raw,file=${path.join(root, 'build', 'os.img')}`,
    '-drive', `format=raw,if=ide,index=1,media=disk,file=${path.join(root, 'build', 'ntfs.img')}`,
    '-serial', 'stdio',
    '-display', 'gtk',   // janela gtk — captura o teclado p/ o convidado
];
console.log('Abrindo o QEMU (modo cru, SEM driver) — DIGITE na janela.');
console.log('Se aparecer "[rawkbd] SCANCANE", o QEMU entrega tecla.\n');
const proc = spawn(qemu, args, { stdio: 'inherit' });
proc.on('exit', (code) => process.exit(code ?? 0));
