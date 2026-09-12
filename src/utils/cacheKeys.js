// Formato de chave único, compartilhado entre rotas e providers — assim um provider
// pode pré-aquecer o cache (ex: conteúdo de capítulo que já veio junto da listagem)
// usando exatamente a mesma chave que a rota vai procurar depois.
module.exports = {
    search: (providerName, q) => `search:${providerName}:${q}`,
    chapters: (providerName, url) => `chapters:${providerName}:${url}`,
    chapterContent: (providerName, url, image = false) => `chapter-content:${providerName}:${url}:image=${Boolean(image)}`,
    // Ponteiro leve: onde (categoria WP + página da REST API) esse capítulo específico
    // provavelmente está, calculado a partir da posição real dele na obra. Não é o
    // conteúdo em si — só permite pular direto pra página certa sem chutar.
    chapterPosition: (providerName, url) => `chapter-position:${providerName}:${url}`,
    latest: (providerName) => `latest:${providerName}`,
};
