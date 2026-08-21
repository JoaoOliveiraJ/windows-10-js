// ===========================================================================
// jsOS - system32/ntos/module.js: mini sistema de modulos CommonJS.
//
// require('ntos/vfs') le o arquivo do bundle embutido (os.readBundleText) e
// executa com (require, module, exports). Todo subsistema do jsOS e um
// modulo exportavel; main.js monta o sistema compondo esses modulos.
// ===========================================================================

globalThis.JSOS = (() => {
    const cache = {};
    const ROOT = 'system32/';   // raiz dos modulos dentro do bundle

    function require(name) {
        if (cache[name]) return cache[name].exports;
        const src = os.readBundleText(ROOT + name + '.js');
        if (src === null) throw new Error('modulo nao encontrado no bundle: ' + name);
        const module = { exports: {} };
        cache[name] = module;   // antes de executar: suporta deps circulares
        const fn = new Function('require', 'module', 'exports',
            src + '\n//# sourceURL=' + name + '.js');
        fn(require, module, module.exports);
        return module.exports;
    }

    function loaded() { return Object.keys(cache); }

    return { require, loaded };
})();
