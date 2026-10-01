@echo off
cd /d "%~dp0"
node tools\preflight.js
node index.js
