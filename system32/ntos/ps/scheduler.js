// ===========================================================================
// jsOS - system32/ntos/ps/scheduler.js: escalonador cooperativo round-robin.
//
// Um processo e uma funcao geradora JS: cada `yield` devolve o controle ao
// kernel; o proximo processo READY roda um passo. Estados:
// ready -> running -> done/killed (reaped pelo kernel).
// ===========================================================================

const procs = [];
let nextPid = 1;

function spawn(name, genFn, ...args) {
    const p = { pid: nextPid++, name, gen: genFn(...args), state: 'ready' };
    procs.push(p);
    return p.pid;
}

function kill(pid) {
    const p = procs.find(p => p.pid === pid);
    if (!p) return false;
    p.state = 'killed';
    return true;
}

function reap() {
    for (let i = procs.length - 1; i >= 0; i--) {
        if (procs[i].state === 'done' || procs[i].state === 'killed')
            procs.splice(i, 1);
    }
}

// um passo de cada processo pronto (round-robin cooperativo)
function tick() {
    reap();
    for (const p of procs) {
        if (p.state !== 'ready') continue;
        p.state = 'running';
        try {
            if (p.gen.next().done) p.state = 'done';
            else p.state = 'ready';
        } catch (e) {
            os.print('[sched] processo ' + p.pid + ' (' + p.name + ') morreu: ' + e.message);
            p.state = 'done';
        }
    }
    reap();
}

module.exports = {
    spawn, kill, tick,
    list()  { return procs.slice(); },
    count() { return procs.length; },
};
