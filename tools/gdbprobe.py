#!/usr/bin/env python3
"""Probe GDB p/ stub do QEMU (-S -s) sob WHPX com breakpoints de software.

Fluxo: continua o boot, vigia o arquivo de serial ate o ataport carregar,
interrompe (Ctrl-C), seta Z0 nos enderecos dados (base do ataport + offsets),
continua e imprime rdx (porta) a cada hit — revela que porta o atapi usa.

  python tools/gdbprobe.py <porta> <serial.log> <off1_hex> [off2_hex ...]
"""
import os
import re
import socket
import sys
import time


class Gdb:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.sock.settimeout(120)
        self.buf = b""

    def _fill(self):
        data = self.sock.recv(4096)
        if not data:
            raise ConnectionError("stub fechou")
        self.buf += data

    def recv_packet(self):
        while True:
            dollar = self.buf.find(b"$")
            hashmark = self.buf.find(b"#", dollar + 1) if dollar >= 0 else -1
            if dollar >= 0 and hashmark >= 0 and len(self.buf) >= hashmark + 3:
                payload = self.buf[dollar + 1:hashmark]
                self.buf = self.buf[hashmark + 3:]
                self.sock.sendall(b"+")
                return payload
            self._fill()

    def cmd(self, payload):
        if isinstance(payload, str):
            payload = payload.encode()
        csum = sum(payload) & 0xFF
        self.sock.sendall(b"$" + payload + b"#" + ("%02x" % csum).encode())
        return self.recv_packet()

    def cont_nowait(self):
        self.sock.sendall(b"$c#%02x" % (sum(b"c") & 0xFF))

    def interrupt(self):
        self.sock.sendall(b"\x03")          # Ctrl-C: para o alvo
        return self.recv_packet()

    def wait_stop(self):
        return self.recv_packet()


def parse_registers(gpacket):
    g = gpacket.decode()
    names = ["rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp"] + \
            ["r%d" % i for i in range(8, 16)] + ["rip"]
    regs = {}
    idx = 0
    for name in names:
        regs[name] = int.from_bytes(bytes.fromhex(g[idx:idx + 16]), "little")
        idx += 16
    return regs


def wait_ataport_base(serial_path, timeout=90):
    deadline = time.time() + timeout
    # ataport e' a imagem de 245760 bytes (11 secoes) carregada p/ o atapi
    pattern = re.compile(rb"base=0x([0-9a-f]+) imagem=245760")
    while time.time() < deadline:
        try:
            with open(serial_path, "rb") as f:
                content = f.read()
            m = pattern.search(content)
            if m:
                return int(m.group(1), 16)
        except FileNotFoundError:
            pass
        time.sleep(0.2)
    return None


def main():
    port = int(sys.argv[1])
    serial_path = sys.argv[2]
    offsets = [int(x, 16) for x in sys.argv[3:]]
    gdb = Gdb(port)
    print("estado inicial:", gdb.cmd(b"?")[:20], flush=True)
    gdb.cont_nowait()                       # comeca o boot
    base = wait_ataport_base(serial_path)
    if not base:
        print("ataport nao carregou a tempo", flush=True)
        return
    print("ataport base=0x%x" % base, flush=True)
    gdb.interrupt()                          # para p/ setar os breakpoints
    for off in offsets:
        print("bp 0x%x ->" % (base + off), gdb.cmd("Z0,%x,1" % (base + off)),
              flush=True)
    for _ in range(80):
        stop = gdb.cont()
        if not (stop.startswith(b"T") or stop.startswith(b"S")):
            print("reply:", stop[:40], flush=True)
            continue
        regs = parse_registers(gdb.cmd(b"g"))
        print("HIT rip=0x%x rdx(porta)=0x%x rax=0x%x rcx=0x%x" %
              (regs["rip"], regs["rdx"], regs["rax"], regs["rcx"]), flush=True)


if __name__ == "__main__":
    main()
