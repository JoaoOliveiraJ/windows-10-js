// ===========================================================================
// jsOS - system32/nano/kernel.js: o nanokernel - registro de servicos.
//
// Filosofia nanokernel: o nucleo faz o MINIMO (interrupcoes, IPC,
// escalonamento). Todo o resto - drivers, FS, console, win32 - sao SERVICOS
// registrados aqui e acessiveis por chamada de servico (mensagem).
// ===========================================================================

const services = new Map();   // nome -> handler(request) => response

function registerService(name, handler) {
    if (services.has(name)) throw new Error('servico duplicado: ' + name);
    services.set(name, handler);
}

function callService(name, request) {
    const h = services.get(name);
    if (!h) throw new Error('servico desconhecido: ' + name);
    return h(request);
}

function hasService(name) { return services.has(name); }
function listServices()   { return [...services.keys()]; }

module.exports = { registerService, callService, hasService, listServices };
