// ===========================================================================
// jsOS - system32/ntos/mm/memory-map.js: o mapa de memoria do jsOS.
// UNICA fonte de verdade para o layout fisico/virtual (evita colisoes).
//
//   0x000000-0x07FFF     tabelas do boot, IDT, memoria compartilhada IRQ
//   0x100000-0x1FFFFF    imagem do kernel (<= 1MB)
//   0x200000-0x2FFFFF    pilha do kernel (topo 0x300000)
//   0x400000-0x4FFFFF    area de .exe PE (1MB)
//   0x500000-0x1FFFFFF   drivers .sys (27MB, 1MB por driver)
//   0x2000000-0x5FFFFFF  heap do kernel (kmalloc, 64MB) — inclui a arena
//                        de 16MB dos drivers convidados
//   0x6000000-0xFFFFFFF  arena PFN (frames fisicos gerenciados, 160MB)
//   0x10000000-0x1FFFFFFF espaco de VA para VirtualAlloc (256MB-512MB);
//                        os enderecos fisicos dessa faixa ficam "mortos"
// ===========================================================================

module.exports = {
    PAGE_SIZE:            0x1000,
    LARGE_PAGE_SIZE:      0x200000,

    PFN_BASE:             0x6000000,    // 96MB
    PFN_TOP:              0x10000000,   // 256MB

    VA_ALLOC_BASE:        0x10000000,   // 256MB
    VA_ALLOC_TOP:         0x20000000,   // 512MB

    // tabelas de paginas construidas pelo stage2 (ver boot/stage2.asm)
    PML4_PHYS:            0x70000,
    PDPT_PHYS:            0x71000,
    PD_PHYS:              0x72000,      // PD0..PD3 seguem (4GB identity)
};
