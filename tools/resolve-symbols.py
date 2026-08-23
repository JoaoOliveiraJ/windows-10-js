#!/usr/bin/env python3
"""
resolve-symbols.py - resolve enderecos do kernel para simbolos C.

Uso:
    python tools/resolve-symbols.py <addr hex> [mais addrs...]

Le build/kernel.elf (gerado pelo build, com tabela de simbolos) e imprime
o simbolo que contem cada endereco (ou o mais proximo abaixo), para
depurar os dumps de excecao da serial (EX:vv @ RIP ... RA=...).
"""
import struct
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELF = os.path.join(ROOT, 'build', 'kernel.elf')


def load_symbols(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'\x7fELF':
        raise SystemExit('nao e ELF: ' + path)
    if data[4] != 2 or data[5] != 1:
        raise SystemExit('precisa ser ELF64 little-endian')
    e_shoff = struct.unpack_from('<Q', data, 0x28)[0]
    e_shentsize = struct.unpack_from('<H', data, 0x3A)[0]
    e_shnum = struct.unpack_from('<H', data, 0x3C)[0]
    e_shstrndx = struct.unpack_from('<H', data, 0x3E)[0]

    def section(i):
        off = e_shoff + i * e_shentsize
        return struct.unpack_from('<IIQQQQIIQQ', data, off)

    symbols = []
    for i in range(e_shnum):
        (sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size,
         sh_link, sh_info, sh_addralign, sh_entsize) = section(i)
        if sh_type != 2:            # SHT_SYMTAB
            continue
        str_sh = section(sh_link)
        str_off, str_size = str_sh[4], str_sh[5]
        strtab = data[str_off:str_off + str_size]
        count = sh_size // sh_entsize
        for j in range(count):
            off = sh_offset + j * sh_entsize
            st_name, st_info, st_other, st_shndx, st_value, st_size = \
                struct.unpack_from('<IBBHQQ', data, off)
            if st_value == 0 or st_shndx == 0:
                continue
            end = strtab.index(b'\0', st_name)
            name = strtab[st_name:end].decode('ascii', 'replace')
            symbols.append((st_value, st_size, name))
    symbols.sort()
    return symbols


def resolve(symbols, addr):
    best = None
    for value, size, name in symbols:
        if value > addr:
            break
        if size and value <= addr < value + size:
            return '%s+0x%x' % (name, addr - value)
        best = (value, name)
    if best:
        return '%s+0x%x (sem tamanho)' % (best[1], addr - best[0])
    return '??'


def main():
    symbols = load_symbols(ELF)
    for arg in sys.argv[1:]:
        addr = int(arg, 16) if arg.lower().startswith('0x') else int(arg, 16)
        print('0x%x -> %s' % (addr, resolve(symbols, addr)))


if __name__ == '__main__':
    main()
