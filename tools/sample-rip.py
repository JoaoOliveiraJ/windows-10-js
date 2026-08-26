#!/usr/bin/env python3
"""Amostra RIP/RSP/RAX etc. do guest via monitor TCP do QEMU.

Uso: python tools/sample-rip.py [porta] [amostras] [intervalo]
Faz stop -> info registers -> cont em cada amostra para garantir
estado fresco mesmo com WHPX (registradores so sincronizam em exit).
"""
import socket
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 44455
SAMPLES = int(sys.argv[2]) if len(sys.argv) > 2 else 8
INTERVAL = float(sys.argv[3]) if len(sys.argv) > 3 else 0.4


def read_until_prompt(sock, buf=b""):
    while True:
        data = sock.recv(4096)
        if not data:
            break
        buf += data
        if buf.rstrip().endswith(b"(qemu)"):
            break
    return buf


def send_cmd(sock, cmd):
    sock.sendall(cmd.encode() + b"\n")
    time.sleep(0.15)
    return read_until_prompt(sock, b"")


def main():
    sock = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    sock.settimeout(5)
    read_until_prompt(sock)
    for i in range(SAMPLES):
        send_cmd(sock, "stop")
        out = send_cmd(sock, "info registers")
        send_cmd(sock, "cont")
        text = out.decode(errors="replace")
        rip = ""
        for line in text.splitlines():
            if line.startswith("RIP=") or "RIP =" in line:
                rip = line.strip()
                break
        print(f"[sample {i}] {rip}")
        if i == 0:
            # primeira amostra: despeja tudo para contexto (RSP, RAX...)
            for line in text.splitlines():
                if "=" in line and not line.startswith("["):
                    print("    " + line.strip())
        time.sleep(INTERVAL)
    sock.close()


if __name__ == "__main__":
    main()
