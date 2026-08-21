@echo off
rem tools\run.bat - boot interativo do jsOS (janela VGA + aceleracao WHPX)
rem Boot BIOS (SeaBIOS) a partir de build\os.img; serial vai p/ build\serial.log
"C:\Program Files\qemu\qemu-system-x86_64.exe" ^
  -m 128 -accel whpx ^
  -drive format=raw,file="%~dp0..\build\os.img" ^
  -serial file:"%~dp0..\build\serial.log" ^
  -no-reboot
