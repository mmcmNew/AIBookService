# Скрипт быстрого деплоя AIBookReader на praga-vps
$ErrorActionPreference = "Stop"

Write-Host "1/5. Сборка фронтенда локально..." -ForegroundColor Cyan
npm run build

Write-Host "2/5. Сборка бэкенда локально..." -ForegroundColor Cyan
npm --prefix server run build

Write-Host "3/5. Упаковка артефактов..." -ForegroundColor Cyan
if (Test-Path deploy.tar.gz) { Remove-Item deploy.tar.gz -Force }
tar -czf deploy.tar.gz dist nginx.conf Dockerfile server/dist server/package.json server/package-lock.json server/Dockerfile

Write-Host "4/5. Отправка на praga-vps..." -ForegroundColor Cyan
scp deploy.tar.gz praga-vps:/opt/aibookreader/
Remove-Item deploy.tar.gz -Force

Write-Host "5/5. Распаковка и перезапуск контейнеров на сервере..." -ForegroundColor Cyan
ssh praga-vps "cd /opt/aibookreader && tar -xzf deploy.tar.gz && rm deploy.tar.gz && docker compose build aibookreader-web aibookreader-api && docker compose up -d aibookreader-web aibookreader-api"

Write-Host "Готово! Проверка статуса сервисов:" -ForegroundColor Green
ssh praga-vps "cd /opt/aibookreader && docker compose ps"
