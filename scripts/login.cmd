@echo off
title dsh-weixin-bot - WeChat QR Login
cd /d "%~dp0.."
echo ============================================
echo   dsh-weixin-bot LOGIN
echo   Scan the QR code with WeChat within 48s.
echo   Get your phone ready BEFORE running this.
echo ============================================
node -e "const {login}=require('weixin-agent-sdk');login({log:console.log}).then(()=>{console.log('LOGIN OK');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
pause
