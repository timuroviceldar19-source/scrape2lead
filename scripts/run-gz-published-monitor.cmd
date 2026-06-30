@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
npm.cmd run kz:monitor-gz-published -- --execute >> logs\gz-published-monitor.log 2>&1
