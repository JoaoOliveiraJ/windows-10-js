// processo de exemplo: rode com "spawn /pisca.js"
// convencao: retorna uma funcao geradora (cooperativa)
return function* (SYS) {
    for (let i = 1; i <= 5; i++) {
        SYS(SYS.byName.print, '[pisca] tick ' + i);
        yield;              // devolve a CPU ao kernel
    }
    SYS(SYS.byName.print, '[pisca] fim');
};
