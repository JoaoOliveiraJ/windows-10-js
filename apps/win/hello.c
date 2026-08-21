/*
 * hello.c - demo de executavel Windows (PE32+) rodando nativo no jsOS.
 * Compilado pelo build com zig cc -target x86_64-windows-gnu -nostdlib.
 * Usa so o mini-kernel32 do jsOS: GetStdHandle + WriteFile.
 */
typedef unsigned long long HANDLE;
typedef unsigned int DWORD;
typedef int BOOL;

__declspec(dllimport) HANDLE GetStdHandle(DWORD nStdHandle);
__declspec(dllimport) BOOL WriteFile(HANDLE hFile, const void *lpBuffer,
                                     DWORD nNumberOfBytesToWrite,
                                     DWORD *lpNumberOfBytesWritten,
                                     void *lpOverlapped);

#define STD_OUTPUT_HANDLE ((DWORD)-11)

void mainCRTStartup(void) {
    const char msg[] = "Ola de um .exe Windows rodando NATIVO no jsOS!\r\n";
    DWORD written = 0;
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    WriteFile(h, msg, sizeof(msg) - 1, &written, 0);
    /* retorna com 'ret': o jsOS retoma o shell */
}
