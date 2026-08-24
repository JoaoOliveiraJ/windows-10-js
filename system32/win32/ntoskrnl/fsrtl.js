// ===========================================================================
// jsOS - system32/win32/ntoskrnl/fsrtl.js: exports FsRtl* (runtime do
// File System do NT) — o que a pilha de storage usa sem depender de um FS.
// ===========================================================================

module.exports = {
    names: [
        'FsRtlGetVirtualDiskNestingLevel',   // -> nivel de VHDs aninhados
        'FsRtlIsSystemPagingFile',           // (fileObject) -> BOOLEAN
    ],
    handlers: [
        // FsRtlGetVirtualDiskNestingLevel() -> 0: nenhum VHD/VHDX aninhado
        // montado no sistema (resposta real — sem discos virtuais nativos)
        () => 0,
        // FsRtlIsSystemPagingFile(fileObjectPtr) -> 0: nao existe pagefile
        // configurado no jsOS — nenhum file object e' o paging file do
        // sistema (a comparacao real do NT e' contra a lista de pagefiles,
        // que aqui e' vazia)
        (_fileObjectPointer) => 0,
    ],
};
