#!/usr/bin/env node
/*
 * test-boot.mjs - boot headless do jsOS no QEMU e valida marcador no serial.
 *
 * Uso: node tools/test-boot.mjs [MARCADOR] [timeout_ms]
 * Sai com codigo 0 se o marcador aparecer na saida serial.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = process.argv[2] || 'HELLO_UEFI_OK';
const timeoutMs = Number(process.argv[3] || 45000);

const qemu = process.env.QEMU || 'C:/Program Files/qemu/qemu-system-x86_64.exe';

function tryBoot(accelArgs) {
    return new Promise((resolve) => {
        const args = [
            '-accel', 'whpx',
            '-m', '4096',
            '-drive', `format=raw,file=${path.join(root, 'build', 'os.img')}`,
            '-drive', `format=raw,if=ide,index=1,media=disk,file=${path.join(root, 'build', 'ntfs.img')}`,
            '-display', 'none',
            '-serial', 'stdio',
            '-no-reboot',
        ];
        const proc = spawn(qemu, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let done = false;
        const finish = (ok, reason) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            proc.kill('SIGKILL');
            resolve({ ok, out, reason });
        };
        const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
        proc.stdout.on('data', (d) => {
            out += d.toString();
            if (out.includes(marker)) finish(true, 'marker');
        });
        proc.stderr.on('data', (d) => { out += d.toString(); });
        proc.on('error', (e) => finish(false, `spawn: ${e.message}`));
        proc.on('exit', (code) => {
            if (!out.includes(marker)) finish(false, `exit ${code}`);
        });
    });
}

let res = await tryBoot(['-accel', 'whpx']);
// sempre WHPX: sem fallback TCG (interrupcoes funcionam so em TCG/hardware;
// sob WHPX o kernel detecta a plataforma e roda em modo polling)

if (res.ok) {
    console.log(`PASS: marcador "${marker}" recebido no serial.`);
    process.exit(0);
} else {
    console.error(`FAIL (${res.reason}): marcador "${marker}" nao recebido.`);
    console.error('--- saida da VM ---');
    console.error(res.out.slice(-4000));
    process.exit(1);
}
