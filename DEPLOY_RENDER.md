# Deploy no Render, Git e UptimeRobot

Este projeto roda como `web service` no Render, coleta ofertas públicas e publica em grupo do WhatsApp via Baileys.

## O que ficou pronto

- `render.yaml` para criação do serviço no Render
- `Procfile` para compatibilidade com deploy baseado em comando
- `/.gitignore` para evitar subir dados locais, sessão do WhatsApp e `node_modules`
- sessão e fila apontadas para `./storage/`
- endpoint HTTP em `/health`
- endpoint de prontidão real do WhatsApp em `/ready`
- página de pareamento em `/qr`
- reset seguro da sessão em `/api/whatsapp/reset-session`

## O que precisa existir no Render

O bot precisa de um volume persistente para guardar:

- a sessão do WhatsApp em `./storage/auth_publico`
- a fila e o histórico em `./storage/data`

No `render.yaml`, isso já foi configurado com um disco montado em:

```txt
/opt/render/project/src/storage
```

## Variáveis importantes no Render

```env
WHATSAPP_GROUP_ID=120363426876382276@g.us
WHATSAPP_LOGIN_METHOD=qr
WHATSAPP_PAIRING_PHONE=
RESET_WHATSAPP_AUTH_ON_START=false
WHATSAPP_AUTH_FOLDER=./storage/auth_publico
DATA_DIR=./storage/data
AUTO_START_COLLECTOR=true
AUTO_START_PUBLISHER=false
AUTO_PUBLISH_AFTER_COLLECT=true
REQUIRE_VERIFIED_IMAGE=true
ALLOW_UNTRUSTED_IMAGE_TESTING=true
PLAYWRIGHT_IMAGE_FALLBACK=false
PUBLISH_ONLY_VALIDATED=true
```

Opcional, mas recomendado para proteger a página de pareamento:

```env
QR_PAGE_TOKEN=uma_senha_forte_aqui
```

Se `QR_PAGE_TOKEN` estiver configurado, abra o QR assim:

```txt
https://SEU-SERVICO.onrender.com/qr?token=uma_senha_forte_aqui
```

## Health check e prontidão

Use `/health` para o Render/UptimeRobot verificar se o servidor HTTP está no ar:

```txt
https://SEU-SERVICO.onrender.com/health
```

Use `/ready` para saber se o WhatsApp está realmente conectado e pronto para publicar:

```txt
https://SEU-SERVICO.onrender.com/ready
```

`/ready` retorna HTTP 503 quando o WhatsApp não está pronto. Não use `/ready` como health check do Render, porque o Render poderia reiniciar o serviço enquanto você ainda está apenas aguardando QR.

## Login do WhatsApp no Render

Abra:

```txt
https://SEU-SERVICO.onrender.com/qr
```

ou, se configurou `QR_PAGE_TOKEN`:

```txt
https://SEU-SERVICO.onrender.com/qr?token=SEU_TOKEN
```

A página mostra o QR em imagem e atualiza automaticamente até o WhatsApp conectar. Se você mudar `WHATSAPP_LOGIN_METHOD` para `pairing` ou `both`, ela também mostra o código de pareamento.

## Modos de login

- `qr`: mostra só QR na página `/qr`
- `pairing`: mostra só o código de pareamento na página `/qr`
- `both`: mostra QR e tenta gerar o código de pareamento ao mesmo tempo

Se quiser usar `pairing` ou `both`, preencha `WHATSAPP_PAIRING_PHONE` com o número no formato internacional, só dígitos.

## Corrigir Bad MAC, MessageCounterError ou QR inválido

Esses erros normalmente indicam sessão Baileys/Signal fora de sincronia, duplicada ou corrompida.

1. No celular do WhatsApp do bot, abra `Aparelhos conectados`.
2. Remova sessões antigas do bot, Render ou computador local.
3. Chame a rota de reset:

```txt
https://SEU-SERVICO.onrender.com/api/whatsapp/reset-session?confirm=RESET&api_key=SUA_API_KEY
```

4. Aguarde o Render reiniciar o serviço.
5. Abra `/qr` e escaneie de novo.

Não rode o mesmo número do bot no Render e no computador local ao mesmo tempo.

## Playwright

`PLAYWRIGHT_IMAGE_FALLBACK` fica `false` no Render para evitar peso de Chromium e reduzir reinícios por consumo de recurso.

Se um dia quiser reativar no Render:

1. Configure `PLAYWRIGHT_IMAGE_FALLBACK=true`.
2. Rode build com Chromium instalado usando `npm run install:playwright` ou ajuste o buildCommand.
3. Monitore memória e tempo de build.

## Git

Fluxo sugerido:

```bash
git add .
git commit -m "Prepare Render deployment"
```

Depois, conecte esse repositório ao GitHub e ao Render.

## Observações

- O Render usa filesystem efêmero por padrão, então sem disco persistente a sessão do WhatsApp e a fila seriam perdidas em cada deploy.
- Deixe apenas um ambiente ativo usando o mesmo número do WhatsApp.
- Se o bot enviar muitas ofertas de uma vez, reduza `MAX_POSTS_PER_RUN`.
