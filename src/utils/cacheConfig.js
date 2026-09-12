// TTLs padrão por tipo de dado cacheado. Rotas e providers compartilham esses valores
// pra não divergir (ex: um provider que pré-aquece o cache de chapter-content precisa
// usar o mesmo TTL que a rota usaria).
module.exports = {
    search: 30 * 60 * 1000,                  // 30 min
    chapters: 12 * 60 * 60 * 1000,           // 12h
    chapterContent: 7 * 24 * 60 * 60 * 1000, // 7 dias
    latest: 15 * 60 * 1000,                  // 15 min
};
