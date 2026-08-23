#!/usr/bin/env python3
# Disassemblador auxiliar para RE de drivers (capstone).
# Uso: python tools/disas.py <arquivo.sys> <rva_inicio> <tamanho> [rva_base_extra]
import sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_64


def rva_to_offset(data, rva):
    # cabecalho PE: secoes mapeiam RVA -> offset de arquivo
    pe_off = int.from_bytes(data[0x3C:0x40], 'little')
    num_sections = int.from_bytes(data[pe_off + 6:pe_off + 8], 'little')
    opt_size = int.from_bytes(data[pe_off + 20:pe_off + 22], 'little')
    sec_table = pe_off + 24 + opt_size
    for i in range(num_sections):
        base = sec_table + i * 40
        virt_size = int.from_bytes(data[base + 8:base + 12], 'little')
        virt_addr = int.from_bytes(data[base + 12:base + 16], 'little')
        raw_size = int.from_bytes(data[base + 16:base + 20], 'little')
        raw_ptr = int.from_bytes(data[base + 20:base + 24], 'little')
        if virt_addr <= rva < virt_addr + max(virt_size, raw_size):
            return raw_ptr + (rva - virt_addr)
    return None


def main():
    path, rva, size = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16)
    with open(path, 'rb') as f:
        data = f.read()
    off = rva_to_offset(data, rva)
    if off is None:
        print(f'RVA {rva:#x} fora das secoes')
        return
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = False
    for insn in md.disasm(data[off:off + size], rva):
        print(f'{insn.address:06x}: {insn.bytes.hex():<24} {insn.mnemonic} {insn.op_str}')


if __name__ == '__main__':
    main()
