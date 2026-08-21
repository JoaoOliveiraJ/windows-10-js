// ===========================================================================
// jsOS - system32/nano/ipc.js: IPC do nanokernel - canais nomeados de
// mensagens entre servicos/processos. Produtor nao conhece o consumidor.
// ===========================================================================

const channels = new Map();   // nome -> { name, queue: [] }

function createChannel(name) {
    if (!channels.has(name)) channels.set(name, { name, queue: [] });
    return channels.get(name);
}

function send(name, message) {
    createChannel(name).queue.push(message);
}

// nao-bloqueante: mensagem ou null
function receive(name) {
    const ch = channels.get(name);
    if (!ch || ch.queue.length === 0) return null;
    return ch.queue.shift();
}

function pending(name) {
    const ch = channels.get(name);
    return ch ? ch.queue.length : 0;
}

function list() { return [...channels.keys()]; }

module.exports = { createChannel, send, receive, pending, list };
