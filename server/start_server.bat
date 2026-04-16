@echo off
echo ============================================
echo  AI Voice Agent - Python Backend
echo ============================================
echo.
echo Checking Python...
python --version
if %errorlevel% neq 0 (
  echo ERROR: Python not found. Install Python 3.10+
  pause
  exit /b 1
)

echo.
echo Installing / updating dependencies...
pip install -r requirements.txt

echo.
echo Starting FastAPI server on ws://localhost:8765
echo Press CTRL+C to stop.
echo.
python main.py
pause
