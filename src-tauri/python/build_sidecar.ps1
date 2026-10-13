# Сборка sidecar pdf_processor в ЧИСТОМ venv -> src-tauri/binaries/pdf_processor-x86_64-pc-windows-msvc.exe
# Использование: powershell -ExecutionPolicy Bypass -File build_sidecar.ps1 [-VenvDir <путь>] [-Python py|python]
param(
    [string]$VenvDir = (Join-Path $env:TEMP "aibr-sidecar-venv"),
    [string]$Python = "python"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcTauri = Split-Path -Parent $here
$work = Join-Path $env:TEMP "aibr-sidecar-build"
$target = Join-Path $srcTauri "binaries\pdf_processor-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    & $Python -m venv $VenvDir
}
$py = Join-Path $VenvDir "Scripts\python.exe"
& $py -m pip install --disable-pip-version-check -q -r (Join-Path $here "requirements-sidecar.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
& $py -m PyInstaller --noconfirm --clean --onefile --console --name pdf_processor `
    --distpath (Join-Path $work "dist") --workpath (Join-Path $work "build") --specpath $work `
    --exclude-module torch --exclude-module torchvision --exclude-module tensorflow `
    --exclude-module matplotlib --exclude-module scipy --exclude-module pandas --exclude-module numpy `
    --exclude-module PIL --exclude-module tkinter --exclude-module IPython --exclude-module pytest `
    --exclude-module onnxruntime --exclude-module pymupdf4llm --exclude-module pymupdf_layout `
    (Join-Path $here "pdf_processor.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$built = Join-Path $work "dist\pdf_processor.exe"
if (-not (Test-Path $built)) { throw "exe not produced" }
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
Copy-Item -Force $built $target
"{0}: {1:N1} MB" -f $target, ((Get-Item $target).Length / 1MB)
