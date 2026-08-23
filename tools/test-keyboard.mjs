#!/usr/bin/env node
/*
 * test-keyboard.mjs - teste do teclado REAL fim-a-fim (driver i8042prt.sys +
 * kbdclass.sys da Microsoft): sobe o jsOS no QEMU com QMP, espera o marcador
 * KBDTEST_READY no serial, injeta a tecla 'a' via QMP sendkey e valida que o
 * READ IRP do kbdclass completou com o MakeCode 0x1E (KBDTEST_OK).
 *
 * Uso: node tools/test-keyboard.mjs [timeout_ms]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.argv[2] || 120000);
const dumpLog = process.argv.includes('--dump');

const qemu = process.env.QEMU || 'C:/Program Files/qemu/qemu-system-x86_64.exe';
const QMP_PORT = 14444;

// manda um comando QMP (abre conexao, negocia capabilities, executa)
function qmpExecute(command, args) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(QMP_PORT, '127.0.0.1');
        let buffer = '';
        let phase = 'greeting';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('qmp timeout')); }, 5000);
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n').filter(l => l.trim().startsWith('{'));
            for (const line of lines) {
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.QMP && phase === 'greeting') {
                    phase = 'capabilities';
                    socket.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
                } else if (phase === 'capabilities' && msg.return !== undefined) {
                    phase = 'command';
                    socket.write(JSON.stringify({ execute: command, arguments: args }) + '\n');
                } else if (phase === 'command' && (msg.return !== undefined || msg.error)) {
                    clearTimeout(timer);
                    socket.end();
                    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                    else resolve(msg.return);
                }
            }
        });
        socket.on('error', reject);
    });
}

async function main() {
    const args = [
        '-accel', 'whpx',
        '-machine', 'pc,kernel-irqchip=off',
        '-m', '4096',
        '-smp', '4',
        '-drive', `format=raw,file=${path.join(root, 'build', 'os.img')}`,
        '-drive', `format=raw,if=ide,index=1,media=disk,file=${path.join(root, 'build', 'ntfs.img')}`,
        '-display', 'none',
        '-serial', 'stdio',
        '-qmp', `tcp:127.0.0.1:${QMP_PORT},server=on,wait=off`,
        '-no-reboot',
    ];
    const proc = spawn(qemu, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let keySent = false;
    let rawSent = false;

    const result = await new Promise((resolve) => {
        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
        function finish(r) {
            clearTimeout(timer);
            proc.kill('SIGKILL');
            resolve(r);
        }
        proc.stdout.on('data', async (d) => {
            out += d.toString();
            if (out.includes('RAWKBD_READY') && !rawSent) {
                rawSent = true;
                try {
                    await qmpExecute('sendkey', {
                        keys: [{ type: 'qcode', data: 'a' }],
                        'hold-time': 150,
                    });
                    out += '\n[harness] sendkey(raw) OK\n';
                } catch (e) {
                    out += `\n[harness] sendkey(raw) FALHOU: ${e.message}\n`;
                }
            }
            if (!keySent && out.includes('KBDTEST_READY')) {
                keySent = true;
                // injeta 'a' algumas vezes (diagnostico de entrega do 8042)
                try {
                    for (let i = 0; i < 3; i++) {
                        await qmpExecute('sendkey', {
                            keys: [{ type: 'qcode', data: 'a' }],
                            'hold-time': 150,
                        });
                        out += `\n[harness] sendkey ${i} OK\n`;
                        await new Promise(r => setTimeout(r, 600));
                    }
                } catch (e) {
                    out += `\n[harness] sendkey FALHOU: ${e.message}\n`;
                }
            }
            if (out.includes('KBDTEST_OK')) finish({ ok: true, reason: 'marker' });
            else if (/SELFTEST FALHOU: .*\n/.test(out))
                finish({ ok: false, reason: 'falha' });
            else if (out.includes('KBDTEST_SKIP') && out.includes('SELFTEST_OK'))
                finish({ ok: false, reason: 'skip' });
        });
        proc.stderr.on('data', (d) => { out += d.toString(); });
        proc.on('error', (e) => finish({ ok: false, reason: `spawn: ${e.message}` }));
        proc.on('exit', (code) => {
            if (!out.includes('KBDTEST_OK')) finish({ ok: false, reason: `exit ${code}` });
        });
    });

    if (result.ok) {
        console.log('PASS: tecla real atravessou 8042->i8042prt->kbdclass (KBDTEST_OK).');
        if (dumpLog) console.log(out);
        process.exit(0);
    } else {
        console.error(`FAIL (${result.reason}): KBDTEST_OK nao recebido.`);
        console.error('--- saida da VM (final) ---');
        console.error(out.slice(-4000));
        process.exit(1);
    }
}

main();
