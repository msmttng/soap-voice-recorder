@echo off
title NSIPS Watcher - SOAP Voice Recorder
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
python -u nsips\soap_nsips_watcher.py -f "\\Ver7\ai‰¹º˜^‰¹" -i 3 -g "https://script.google.com/macros/s/AKfycbwCGoQvI3IeKZEEWBV5x-vpVF1sFRnKG1p6O4eZ9OFNqsqgyph1l5aRnSwb_4tbmM3D/exec" >> soap_nsips.log 2>&1
