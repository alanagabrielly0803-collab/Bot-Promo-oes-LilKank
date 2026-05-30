# Deploy no Render, Git e UptimeRobot

Este diretório foi preparado para rodar o bot fora do ambiente local e subir como `web service` no Render.

## O que ficou pronto

- `render.yaml` para criação do serviço no Render
- `Procfile` para compatibilidade com deploy baseado em comando
- `/.gitignore` para evitar subir dados locais, sessão do WhatsApp e `node_modules`
- sessão e fila apontadas para `./storage/`
- endpoint de saúde em `/health`

## O que precisa existir no Render

O bot precisa de um volume persistente para guardar:

- a sessão do WhatsApp em `./storage/auth_publico`
- a fila e o histórico em `./storage/data`

No `render.yaml`, isso já foi configurado com um disco montado em:

```txt
/opt/render/project/src/storage
```

## Primeiro deploy

1. Suba este diretório para um repositório Git.
2. Conecte esse repositório ao Render.
3. Garanta que o serviço use o `render.yaml`.
4. No primeiro boot, confira os logs do Render e escaneie o QR Code do WhatsApp.
5. Depois que a sessão ficar salva no disco, o bot passa a reconectar sem QR novo a cada deploy.

## Variáveis importantes no Render

As variáveis principais já estão no `render.yaml`, mas vale conferir no painel:

```env
WHATSAPP_GROUP_ID=
WHATSAPP_LOGIN_METHOD=qr
WHATSAPP_PAIRING_PHONE=
WHATSAPP_AUTH_FOLDER=./storage/auth_publico
DATA_DIR=./storage/data
AUTO_START_COLLECTOR=true
AUTO_START_PUBLISHER=false
REQUIRE_VERIFIED_IMAGE=true
PLAYWRIGHT_IMAGE_FALLBACK=false
PUBLISH_ONLY_VALIDATED=true
```

## UptimeRobot

Configure um monitor HTTP apontando para:

```txt
/health
```

Exemplo:

```txt
https://SEU-SERVICO.onrender.com/health
```

O endpoint retorna `200` quando o servidor HTTP está no ar.

## QR do WhatsApp no Render

Se o QR não ficar legível no log, abra:

```txt
https://SEU-SERVICO.onrender.com/qr
```

Essa página mostra o QR em imagem e atualiza automaticamente até o WhatsApp conectar.
Se você configurar `WHATSAPP_LOGIN_METHOD=pairing` ou `both`, ela também mostra o código de pareamento.

## Modos de login

- `qr`: mostra QR na página `/qr`
- `pairing`: mostra o código de pareamento na página `/qr`
- `both`: tenta gerar código de pareamento e também mantém o QR visível

## Git

Fluxo sugerido:

```bash
git init
git add .
git commit -m "Prepare Render deployment"
```

Depois, conecte esse repositório ao GitHub e ao Render.

## Observações

- O Render usa filesystem efêmero por padrão, então sem disco persistente a sessão do WhatsApp e a fila seriam perdidas em cada deploy.
- O `PLAYWRIGHT_IMAGE_FALLBACK` ficou desligado no Render para evitar download pesado de navegador no build.
- Se você quiser reativar a imagem por Playwright no Render, será preciso revisar o build e a instalação do Chromium.
