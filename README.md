# Bot de ofertas públicas + WhatsApp

Este projeto coleta links da Shopee publicados em fontes públicas de ofertas e posta automaticamente em um grupo do WhatsApp.

Ele **não usa API da Shopee**, **não tenta burlar bloqueios** e **não usa serviço pago de scraping**. A ideia é monitorar fontes públicas que você configurar, filtrar links da Shopee e publicar no grupo.

## Fluxo

```txt
Fontes públicas de ofertas
↓
Coletor encontra links da Shopee
↓
Filtro de utilitários de casa
↓
Fila local JSON
↓
Bot WhatsApp posta foto/legenda ou texto/link
```

## Instalação local

```bash
npm install
copy .env.example .env
npm start
```

No Linux/macOS:

```bash
npm install
cp .env.example .env
npm start
```

Na primeira execução, escaneie o QR Code no WhatsApp:

```txt
WhatsApp > Aparelhos conectados > Conectar aparelho
```

## Configuração principal

Edite o `.env`:

```env
WHATSAPP_GROUP_ID=
PUBLIC_SOURCE_URLS=https://www.promobit.com.br/promocoes/casa-e-cozinha/,https://www.pelando.com.br/casa-e-cozinha
RSS_SOURCE_URLS=
DISCOVERY_INTERVAL_MINUTES=180
POST_INTERVAL_MINUTES=60
MAX_POSTS_PER_RUN=1
```

Para descobrir o ID do grupo, envie no privado do bot ou em qualquer chat:

```txt
/grupos
```

Copie o ID do grupo desejado e coloque no `.env` como `WHATSAPP_GROUP_ID`.

## Comandos no WhatsApp

```txt
/status      mostra status e fila
/coletar     força coleta das fontes agora
/fila        mostra próximas ofertas pendentes
/postar      posta uma oferta agora no chat atual
/testeoferta posta uma oferta agora no chat atual
/pausar      pausa postagem automática
/ativar      reativa postagem automática
/grupos      lista grupos e IDs
/fontes      mostra fontes configuradas
```

## Testar sem esperar coleta

Adicione uma oferta fake na fila:

```bash
npm run test:message
```

Depois use `/postar` no WhatsApp.

## Adicionar fontes

Use fontes públicas que você tem permissão para monitorar. O bot procura links contendo `shopee.com.br` dentro dessas páginas/feeds.

Exemplo:

```env
PUBLIC_SOURCE_URLS=https://site1.com/ofertas-casa,https://site2.com/promocoes
RSS_SOURCE_URLS=https://site3.com/feed.xml
```

## Filtro de foco

O foco inicial é utilitários de casa. Ajuste:

```env
OFFER_KEYWORDS=organizador,cozinha,banheiro,suporte,adesivo,escorredor,rodo,microfibra,luminaria,cabide,prateleira
BLOCK_KEYWORDS=roupa,maquiagem,celular,notebook,perfume,bolsa,sapato,relogio,brinquedo
MAX_PRICE=100
```

## Observações

- O banco local fica em `data/`.
- A sessão do WhatsApp fica em `auth/`.
- Não envie `.env`, `data/` ou `auth/` para o GitHub.
- Se uma fonte pública não expuser links diretos da Shopee no HTML, ela pode coletar 0 ofertas.
- A prévia/imagem depende do link encontrado e do WhatsApp.

## Deploy no Render

Se você quer subir essa versão no Git e no Render, use o guia:

- [DEPLOY_RENDER.md](./DEPLOY_RENDER.md)
