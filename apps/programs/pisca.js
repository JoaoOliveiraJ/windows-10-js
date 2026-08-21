// processo de exemplo: rode com "spawn /pisca.js"
// convencao: retorna uma funcao geradora (cooperativa)
return function* (SystemCall) {
    for (let i = 1; i <= 5; i++) {
        SystemCall(SystemCall.byName.print, '[pisca] tick ' + i);
        yield;              // devolve a CPU ao kernel
    }
    SystemCall(SystemCall.byName.print, '[pisca] fim');
};
