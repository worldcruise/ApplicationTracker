@echo off
setlocal

where py >nul 2>nul
if errorlevel 1 goto use_python

py -3 -u "%~dp0candidate_host.py" %*
exit /b %errorlevel%

:use_python
python -u "%~dp0candidate_host.py" %*
exit /b %errorlevel%