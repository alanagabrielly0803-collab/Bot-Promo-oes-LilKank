function buildOfferMessage(offer) {
  const price = offer.priceText || (offer.price ? `R$ ${Number(offer.price).toFixed(2).replace('.', ',')}` : 'Confira no link');
  const cleanPrice = String(price).replace(/\s+/g, ' ').trim();
  const titleFromUrl = offer.url
    ? String(offer.url).split('/').filter(Boolean).pop().replace(/[-_]+/g, ' ')
    : '';
  const title = offer.title && !/^(ver oferta|pegar cupom|oferta|shopee)$/i.test(String(offer.title).trim())
    ? offer.title
    : (titleFromUrl || 'Oferta Shopee');
  const sourceLabel = offer.reviewSourceUrl ? 'Fonte validada' : 'Fonte pública';
  const imageLabel = offer.imageVerified ? 'Imagem confiável' : 'Imagem não confiável';
  const imageSource = offer.imageSource ? ` • ${offer.imageSource}` : '';

  return [
    '🔥 ACHADINHO PARA CASA',
    '',
    `🏠 Produto: ${title}`,
    `💰 Preço: ${cleanPrice}`,
    '',
    `✅ ${sourceLabel}.`,
    `🖼️ ${imageLabel}${imageSource}`,
    '',
    '🔗 Ver na Shopee:',
    offer.url,
    '',
    '⚠️ Preço e disponibilidade podem mudar a qualquer momento.'
  ].join('\n');
}

module.exports = { buildOfferMessage };
