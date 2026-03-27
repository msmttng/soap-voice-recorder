@echo off
title NSIPS Watcher - SOAP Voice Recorder
echo =============================================
echo  NSIPS フォルダ監視サービス
echo  Ctrl+C で停止
echo =============================================
echo.

cd /d "%~dp0"
python nsips\nsips_watcher.py -f "\\Ver7\ai音声録音" -i 3

pause
