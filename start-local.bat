@echo off
title Bot Ofertas Publicas WhatsApp
if not exist .env (
  copy .env.example .env
  echo Arquivo .env criado. Edite com suas fontes e WHATSAPP_GROUP_ID.
)
npm install
npm start
pause
