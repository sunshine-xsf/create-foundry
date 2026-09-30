@echo off
setlocal
rem Azure AI Foundry local deployment console.
rem Paste SP credentials in the browser; no local config is required.
pushd "%~dp0"
if errorlevel 1 exit /b 2
set "PYTHON_EXE="
if defined FOUNDRY_PYTHON call :try_python "%FOUNDRY_PYTHON%"
if defined PYTHON_EXE goto run
rem Prefer the workspace-managed Python when available.
for /d %%D in ("%~dp0..\.uv-python\cpython-*") do call :try_python "%%~fD\python.exe"
if defined PYTHON_EXE goto run
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do call :try_python "%%~fD\python.exe"
if defined PYTHON_EXE goto run
for /d %%D in ("%ProgramFiles%\Python3*") do call :try_python "%%~fD\python.exe"
if defined PYTHON_EXE goto run
for /f "delims=" %%P in ('where python.exe 2^>nul') do call :try_python "%%P"
if defined PYTHON_EXE goto run
py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 goto run_py
echo ERROR: Python 3.10 or newer was not found.
echo Install Python 3.10+ or set FOUNDRY_PYTHON to python.exe.
echo The web console needs only the Python standard library.
pause
exit /b 2

:run
echo Starting the local Foundry deployment console...
"%PYTHON_EXE%" -u "%~dp0foundry_web.py"
goto finish

:run_py
echo Starting the local Foundry deployment console...
py -3 -u "%~dp0foundry_web.py"
goto finish

:finish
echo.
echo The local deployment console has stopped.
pause
popd
exit /b

:try_python
if defined PYTHON_EXE exit /b 0
if not exist "%~1" exit /b 0
"%~1" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 set "PYTHON_EXE=%~1"
exit /b 0