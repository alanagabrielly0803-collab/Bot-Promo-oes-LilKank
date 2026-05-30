const { enqueueOffers, queueStats } = require('./queue/offerQueue');

enqueueOffers([
  {
    title: 'Organizador de Cozinha Multifuncional - oferta de teste',
    price: 24.9,
    priceText: 'R$ 24,90',
    imageUrl: '',
    url: 'https://shopee.com.br/',
    source: 'test'
  }
]);

console.log('Oferta de teste adicionada.', queueStats());
