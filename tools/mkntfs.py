#!/usr/bin/env python3
"""
mkntfs.py - gera build/ntfs.img: um NTFS minimo valido para testar o parser
do jsOS (ntos/fs/ntfs.js).

Layout: setor/cluster = 512B, 4MB, MFT no LCN 4, records de 1KB.
Registros: 0=$MFT 1=$MFTMirr 2=$LogFile 3=$Volume 4=$AttrDef 5='.' (raiz)
           6=HELLO.TXT (dados residentes).
"""
import struct, sys, os

SECTOR = 512
CLUSTER = 512                      # 1 setor por cluster
TOTAL_SECTORS = 8192               # 4MB
MFT_LCN = 4
RECORD_SIZE = 1024
N_RECORDS = 7
MFT_CLUSTERS = (N_RECORDS * RECORD_SIZE) // CLUSTER   # 14

img = bytearray(TOTAL_SECTORS * SECTOR)

# ---------------------------------------------------------------- boot sector
bs = bytearray(SECTOR)
bs[0:3] = b'\xeb\x52\x90'
bs[3:11] = b'NTFS    '
struct.pack_into('<H', bs, 11, SECTOR)          # bytes/setor
bs[13] = 1                                      # setores/cluster (1)
struct.pack_into('<I', bs, 40, TOTAL_SECTORS)   # total setores
struct.pack_into('<Q', bs, 48, MFT_LCN)         # MFT LCN
struct.pack_into('<Q', bs, 56, MFT_LCN + 1)     # MFTMirr LCN
struct.pack_into('<b', bs, 64, -10)             # record size = 2^10 = 1KB
struct.pack_into('<b', bs, 68, 4)               # index block = 4KB... (4<<8?) usa 4
struct.pack_into('<Q', bs, 72, 0x4A53534F53543421)  # volume serial
bs[510:512] = b'\x55\xaa'
img[0:SECTOR] = bs

# ------------------------------------------------------------- record builder
def make_record(recno, flags, attrs):
    rec = bytearray(RECORD_SIZE)
    rec[0:4] = b'FILE'
    struct.pack_into('<H', rec, 4, 48)          # USA offset
    struct.pack_into('<H', rec, 6, 3)           # USA count (2 setores + 1)
    struct.pack_into('<H', rec, 16, 1)          # sequence
    struct.pack_into('<H', rec, 18, 1)          # link count
    struct.pack_into('<H', rec, 20, 56)         # attrs offset (apos USA)
    struct.pack_into('<H', rec, 22, flags)      # 1=in use | 2=directory
    struct.pack_into('<I', rec, 28, RECORD_SIZE)
    struct.pack_into('<I', rec, 44, recno)
    off = 56
    for blob in attrs:
        rec[off:off+len(blob)] = blob
        off += len(blob)
    struct.pack_into('<I', rec, off, 0xFFFFFFFF)   # fim dos atributos
    struct.pack_into('<I', rec, 24, off + 8)       # tamanho usado
    # fixup (USA): USN=1 nos tails dos setores; originais na USA
    usn = 1
    struct.pack_into('<H', rec, 48, usn)
    struct.pack_into('<H', rec, 50, rec[SECTOR-2:SECTOR][0] | (rec[SECTOR-1]<<8))
    struct.pack_into('<H', rec, 52, rec[2*SECTOR-2] | (rec[2*SECTOR-1]<<8))
    struct.pack_into('<H', rec, SECTOR-2, usn)
    struct.pack_into('<H', rec, 2*SECTOR-2, usn)
    return rec

def attr_resident(atype, value, attr_id=0):
    total = 24 + len(value)
    total = (total + 7) & ~7
    a = bytearray(total)
    struct.pack_into('<I', a, 0, atype)
    struct.pack_into('<I', a, 4, total)
    a[8] = 0                                     # residente
    struct.pack_into('<H', a, 14, attr_id)
    struct.pack_into('<I', a, 16, len(value))
    struct.pack_into('<H', a, 20, 24)            # value offset
    a[24:24+len(value)] = value
    return a

def attr_nonresident(atype, runs, real_size, attr_id=0):
    # runs: bytes do runlist ja montados
    total = 64 + len(runs)
    total = (total + 7) & ~7
    a = bytearray(total)
    struct.pack_into('<I', a, 0, atype)
    struct.pack_into('<I', a, 4, total)
    a[8] = 1                                     # nao-residente
    struct.pack_into('<H', a, 14, attr_id)
    # highestVCN = clusters - 1
    struct.pack_into('<Q', a, 16, 0)             # lowest VCN
    struct.pack_into('<Q', a, 24, (real_size // CLUSTER) - 1)
    struct.pack_into('<H', a, 32, 64)            # runlist offset
    struct.pack_into('<Q', a, 40, real_size)     # alocado
    struct.pack_into('<Q', a, 48, real_size)     # real
    struct.pack_into('<Q', a, 56, real_size)     # inicializado
    a[64:64+len(runs)] = runs
    return a

SI = attr_resident(0x10, bytearray(72))          # $STANDARD_INFORMATION vazio

def file_name_attr(parent_ref, name, is_dir, real_size=0):
    nb = name.encode('utf-16-le')
    v = bytearray(66 + len(nb))
    struct.pack_into('<Q', v, 0, parent_ref)
    struct.pack_into('<Q', v, 40, real_size)
    struct.pack_into('<Q', v, 48, real_size)
    struct.pack_into('<I', v, 56, 0x06 if is_dir else 0x20)
    v[64] = len(name)
    v[65] = 3 if name in ('.',) else 1           # namespace
    v[66:] = nb
    return attr_resident(0x30, v)

# ---------------------------------------------------------------- $MFT (rec 0)
runlist = bytes([0x11, MFT_CLUSTERS, MFT_LCN, 0x00])   # 1 run: LCN 4, 14 clusters
mft_self = make_record(0, 1, [SI, file_name_attr(5, '$MFT', False),
                              attr_nonresident(0x80, runlist, N_RECORDS * RECORD_SIZE)])
img[MFT_LCN*CLUSTER : MFT_LCN*CLUSTER + RECORD_SIZE] = mft_self

records = {
    1: [SI, file_name_attr(5, '$MFTMirr', False)],
    2: [SI, file_name_attr(5, '$LogFile', False)],
    3: [SI, file_name_attr(5, '$Volume', False),
        attr_resident(0x60, 'JSOS'.encode('utf-16-le')),
        attr_resident(0x70, bytearray(12))],
    4: [SI, file_name_attr(5, '$AttrDef', False)],
}

# ------------------------------------------------------------- raiz (rec 5)
HELLO_NAME = 'HELLO.TXT'
HELLO_DATA = b'Ola do NTFS no jsOS!\r\n'

hello_fn_value = file_name_attr(5, HELLO_NAME, False, len(HELLO_DATA))[24:24+66+len(HELLO_NAME)*2]

# INDEX_ROOT com 1 entrada + entrada final
entry_stream = bytes(hello_fn_value)
entry_size = (16 + len(entry_stream) + 7) & ~7
idx_entry = bytearray(entry_size)
struct.pack_into('<Q', idx_entry, 0, 6)                # ref do record 6
struct.pack_into('<H', idx_entry, 8, entry_size)
struct.pack_into('<H', idx_entry, 10, len(entry_stream))
struct.pack_into('<H', idx_entry, 12, 0)               # flags
idx_entry[16:16+len(entry_stream)] = entry_stream
idx_last = bytearray(16)
struct.pack_into('<H', idx_last, 8, 16)
struct.pack_into('<H', idx_last, 12, 2)                # last

entries = bytes(idx_entry) + bytes(idx_last)
index_root = bytearray(16 + 16 + len(entries))
struct.pack_into('<I', index_root, 0, 0x30)            # indexa $FILE_NAME
struct.pack_into('<I', index_root, 4, 1)               # collation FILENAME
struct.pack_into('<I', index_root, 8, 4096)            # index block
index_root[12] = 1
struct.pack_into('<I', index_root, 16, 16)             # entriesOffset
struct.pack_into('<I', index_root, 20, len(entries))   # totalSize
struct.pack_into('<I', index_root, 24, len(entries))   # allocSize
struct.pack_into('<I', index_root, 28, 0)
index_root[32:32+len(entries)] = entries

records[5] = [SI, file_name_attr(5, '.', True), attr_resident(0x90, index_root)]
records[6] = [SI, file_name_attr(5, HELLO_NAME, False, len(HELLO_DATA)),
              attr_resident(0x80, HELLO_DATA)]

for recno, attrs in records.items():
    flags = 3 if recno == 5 else 1
    img[MFT_LCN*CLUSTER + recno*RECORD_SIZE :
        MFT_LCN*CLUSTER + recno*RECORD_SIZE + RECORD_SIZE] = \
        make_record(recno, flags, attrs)

out = sys.argv[1] if len(sys.argv) > 1 else 'build/ntfs.img'
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'wb').write(img)
print(f'{out}: NTFS {TOTAL_SECTORS*SECTOR//1048576}MB, HELLO.TXT na raiz')
