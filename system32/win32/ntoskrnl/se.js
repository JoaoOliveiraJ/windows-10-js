// ===========================================================================
// jsOS - system32/win32/ntoskrnl/se.js: exports Se* (Security Reference
// Monitor). Nosso kernel tem UM contexto de seguranca (kernel/SYSTEM): as
// checagens de privilegio respondem com a semantica real desse contexto.
// ===========================================================================

module.exports = {
    names: [
        'SeSinglePrivilegeCheck',
    ],
    handlers: [
        // SeSinglePrivilegeCheck(privilegeLuidPtr, requestorMode): todo codigo
        // aqui roda em kernel mode (modo 0) — o contexto kernel tem TODOS os
        // privilegios habilitados (como um driver no Windows de verdade)
        (_privilegePointer, requestorMode) => (requestorMode >>> 0) === 0 ? 1 : 0,
    ],
};
