#!/usr/bin/env python3
"""Varre a memoria do guest via stub GDB do QEMU (-S -s) procurando os
valores de base IDE (0x1F0/0x3F6/0x170/0x376) que o atapi gravou — revela se
o atapi computou o base certo do canal. Continua o boot, espera o marker no
serial, interrompe, e varre a regiao.

  python tools/gdbscan.py <porta> <serial.log>
"""
import socket
import sys
import time


class Gdb:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.sock.settimeout(30)
        self.buf = b""

    def _fill(self):
        d = self.sock.recv(65536)
        if not d:
            raise ConnectionError("stub fechou")
        self.buf += d

    def recv_packet(self):
        while True:
            dollar = self.buf.find(b"$")
            hashm = self.buf.find(b"#", dollar + 1) if dollar >= 0 else -1
            if dollar >= 0 and hashm >= 0 and len(self.buf) >= hashm + 3:
                p = self.buf[dollar + 1:hashm]
                self.buf = self.buf[hashm + 3:]
                self.sock.sendall(b"+")
                return p
            self._fill()

    def cmd(self, p):
        if isinstance(p, str):
            p = p.encode()
        self.sock.sendall(b"$" + p + b"#" + ("%02x" % (sum(p) & 0xFF)).encode())
        return self.recv_packet()

    def cont(self):
        self.sock.sendall(b"$c#%02x" % (sum(b"c") & 0xFF))

    def interrupt(self):
        self.sock.sendall(b"\x03")
        return self.recv_packet()

    def read_mem(self, addr, length):
        r = self.cmd("m%x,%x" % (addr, length))
        if r.startswith(b"E"):
            return None
        return bytes.fromhex(r.decode())


def main():
    port = int(sys.argv[1])
    serial_path = sys.argv[2]
    gdb = Gdb(port)
    print("estado:", gdb.cmd(b"?")[:16], flush=True)
    gdb.cont()   # comeca o boot (nao bloqueia de verdade aqui)
    # espera o boot terminar (fileio halt) — a deteccao do atapi ja' rodou
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            with open(serial_path, "rb") as f:
                c = f.read()
            if b"KERNEL_JS_OK" in c and (b"SELFTEST" in c or b"halt" in c):
                break
        except FileNotFoundError:
            pass
        time.sleep(0.4)
    time.sleep(1.0)
    gdb.interrupt()
    print("interrompido; varrendo...", flush=True)
    # valores alvo (u32 LE)
    targets = {0x1F0: b"\xf0\x01\x00\x00", 0x170: b"\x70\x01\x00\x00",
               0x3F6: b"\xf6\x03\x00\x00", 0x376: b"\x76\x03\x00\x00",
               0x1F7: b"\xf7\x01\x00\x00", 0xC041: b"\x41\xc0\x00\x00"}
    found = {k: [] for k in targets}
    start, end, step = 0x400000, 0x1600000, 0x4000
    addr = start
    while addr < end:
        chunk = gdb.read_mem(addr, step)
        if chunk:
            for val, pat in targets.items():
                i = 0
                while True:
                    i = chunk.find(pat, i)
                    if i < 0:
                        break
                    found[val].append(addr + i)
                    i += 1
        addr += step
    for val, addrs in found.items():
        print("0x%x: %d ocorrencias%s" % (val, len(addrs),
              (" em " + ",".join("0x%x" % a for a in addrs[:8])) if addrs else ""))


if __name__ == "__main__":
    main()
