@echo off
echo ========================================================
echo   Сборка AIBookReader в EXE установщик (Tauri v2)
echo ========================================================
call npm run tauri:build
echo.
echo ========================================================
echo   Сборка успешно завершена!
echo   EXE-установщик находится здесь:
echo   src-tauri\target\release\bundle\nsis\AIBookReader_1.0.0_x64-setup.exe
echo ========================================================
pause
