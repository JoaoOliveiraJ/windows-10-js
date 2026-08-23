@echo off
rem tools\run.bat - boot interativo do jsOS (janela VGA + aceleracao WHPX)
rem Boot BIOS (SeaBIOS) a partir de build\os.img; serial vai p/ build\serial.log
for %%I in ("%~dp0..\build") do set "BUILDDIR=%%~fI"
if not exist "%BUILDDIR%\serial.log" type nul > "%BUILDDIR%\serial.log"
"C:\Program Files\qemu\qemu-system-x86_64.exe" ^
  -m 4096 -smp 4 -accel whpx -machine pc,kernel-irqchip=off ^
  -drive format=raw,file="%BUILDDIR%\os.img" ^
  -drive format=raw,if=ide,index=1,media=disk,file="%BUILDDIR%\ntfs.img" ^
  -display sdl ^
  -serial file:"%BUILDDIR%\serial.log" ^
  -no-reboot
