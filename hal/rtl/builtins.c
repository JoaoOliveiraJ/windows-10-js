/*
 * builtins.c - helpers de 128-bit que o compiler-rt nao forneceu no alvo
 * freestanding do zig. Divisao binaria longa simples (rara, so dtoa).
 */

typedef unsigned __int128 u128;

static u128 udivmod128(u128 n, u128 d, u128 *rem) {
    u128 q = 0, r = 0;
    int i;
    for (i = 127; i >= 0; i--) {
        r = (r << 1) | ((n >> i) & 1);
        if (r >= d) {
            r -= d;
            q |= (u128)1 << i;
        }
    }
    if (rem) *rem = r;
    return q;
}

u128 __udivti3(u128 n, u128 d) {
    return udivmod128(n, d, 0);
}

u128 __umodti3(u128 n, u128 d) {
    u128 r;
    udivmod128(n, d, &r);
    return r;
}
