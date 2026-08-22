// ordem dos grupos de exports do ntoskrnl (a ABI depende dela!)
// append-only dentro de cada grupo; os ids reais = 32 + indice concatenado.
// O build (tools/build.mjs) le esta ordem para gerar ntoskrnl.lib.
module.exports = [ 'ke', 'io', 'mm', 'ex', 'rtl', 'zw', 'ps', 'po' ];
