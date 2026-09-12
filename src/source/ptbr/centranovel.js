const axios = require("axios");
const cheerio = require("cheerio");
const https = require('https');
const BaseProvider = require('@/template/BaseProvider');
const cache = require('@/utils/cache');
const cacheKeys = require('@/utils/cacheKeys');
const cacheTTL = require('@/utils/cacheConfig');

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false // Ignora a verificação do certificado
    })
});

class CentraNovelProvider extends BaseProvider {
    constructor() {
        super('centralnovel', 'https://centralnovel.com', 'novel');
        this.wpApiUrl = `${this.baseUrl}/wp-json/wp/v2`;
    }

    // Converte números tipo "1.7.6" (algumas obras numeram capítulo.seção.subseção,
    // não só capítulo.subcapítulo) num float comparável, sem colidir. parseFloat comum
    // trunca no segundo ponto ("1.7.6" -> 1.7), fazendo 1.7.1..1.7.9 virarem tudo igual.
    // Aqui cada nível vale 1/1000 do anterior — margem enorme pra qualquer sub-número.
    // Também trata sufixo de letra ("124A"/"124B" -> vira mais um nível: A=1, B=2...),
    // já que parseInt sozinho ignora a letra e faria os dois virarem 124.
    parseVersionNumber(str) {
        const segments = str.replace(',', '.').split('.');
        const parts = [];

        for (const segment of segments) {
            const match = segment.match(/^(\d+)([a-zA-Z]*)$/);
            if (!match) return null;

            parts.push(parseInt(match[1], 10));
            if (match[2]) {
                parts.push(match[2].toUpperCase().charCodeAt(0) - 64);
            }
        }

        return parts.length ? parts.reduce((acc, part, i) => acc + part / Math.pow(1000, i), 0) : null;
    }

    // Extrai o slug (última parte do path) de uma url absoluta ou relativa
    extractSlug(url) {
        const path = url.replace(this.baseUrl, '');
        const segments = path.split('/').filter(Boolean);
        return segments[segments.length - 1];
    }

    // Caixa de busca ao vivo do próprio site (POST em admin-ajax.php). Limitada a 10
    // resultados, mas já vem com gênero e imagem — não precisa enriquecer depois.
    async searchNovel(query) {
        try {
            const body = new URLSearchParams({ action: 'ts_ac_do_search', ts_ac_query: query }).toString();
            const { data } = await axiosInstance.post(
                `${this.baseUrl}/wp-admin/admin-ajax.php`,
                body,
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            const items = data?.series?.[0]?.all || [];
            return items.map(item => ({
                url: item.post_link,
                title: item.post_title,
                chapter: null,
                imageUrl: item.post_image ? item.post_image.split('?')[0] : null,
                rating: null,
                genre: item.post_genres ? item.post_genres.split(',').map(g => g.trim()) : [],
            }));
        } catch (error) {
            console.error("Erro ao buscar o conteúdo:", error.message);
            throw error;
        }
    }

    async readNovelInfo(novelUrl) {
        try {
            const fullUrl = this.getFullUrl(novelUrl);
            const { data } = await axiosInstance.get(fullUrl);
            const $ = cheerio.load(data);

            const title = this.parseTitle($);
            const coverUrl = this.parseCover($);
            const authors = this.parseAuthors($);
            const synopsis = $('.entry-content').text().trim();
            const titles = $('.ninfo .alter').text().trim().split(',').filter(Boolean);

            const genres = [];
            $('.genxed a').each((index, element) => {
                genres.push($(element).text().trim());
            });

            const { volumes, orderedChapterUrls } = this.parseVolumesFromPage($);

            if (orderedChapterUrls.length > 0) {
                const slug = this.extractSlug(fullUrl);
                await this.cacheChapterPositions(slug, orderedChapterUrls);
            }

            return {
                title,
                coverUrl,
                author: authors,
                titles,
                genres,
                synopsis,
                volumes: volumes.length,
                data: volumes,
                chapters: volumes.reduce((sum, vol) => sum + vol.chapters.length, 0)
            };
        } catch (error) {
            console.error("Erro ao buscar os capítulos:", error.message);
            throw error;
        }
    }

    // A própria página da obra já traz todos os capítulos embutidos no HTML (accordion
    // por volume, escondido via CSS) — confirmado até em obras com 3000+ capítulos.
    // Usa o rótulo de volume como veio no site ("13", "Extra", ...) em vez de tentar
    // extrair do título do post na REST API, que varia de obra pra obra (algumas nem
    // colocam "Volume" no título, só "Capítulo N").
    parseVolumesFromPage($) {
        const rawChapters = [];

        $('.eplister li').each((index, element) => {
            const chapterUrl = $(element).find('a').attr('href');
            if (!chapterUrl) return;

            const chapterNum = $(element).find('.epl-num').text().trim();
            const chapterTitle = $(element).find('.epl-title').text().trim();
            const volumeMatch = chapterNum.match(/Vol\.\s*(.+?)\s*Cap\./i);
            const capMatch = chapterNum.match(/Cap\.\s*(.+)$/i);

            // Número real do capítulo como o site mostra (ex: "Cap. 600" -> 600). Usa
            // isso como index sempre que der — assim fica estável mesmo se o site
            // pular um número e lançar depois (ex: tem 1-49 e 51-100, e o 50 sai mais
            // tarde: o 51 continua sendo 51, não desloca por causa do furo).
            const parsedNum = capMatch ? this.parseVersionNumber(capMatch[1].trim()) : null;

            rawChapters.push({
                url: chapterUrl,
                capitulo: chapterNum,
                name: chapterTitle,
                volumeLabel: volumeMatch ? volumeMatch[1].trim() : null,
                realIndex: parsedNum,
            });
        });

        // A listagem do site vem do mais novo pro mais antigo — inverte pra ordem real
        // de leitura (também vira a base da posição global de cada capítulo na obra).
        rawChapters.reverse();

        const volumes = [];
        const volumeIndexByLabel = new Map();
        const lastNumericIndexByVolume = new Map();
        const nonNumericStreakByVolume = new Map();

        rawChapters.forEach(chapter => {
            const key = chapter.volumeLabel ?? 'no-volume';
            if (!volumeIndexByLabel.has(key)) {
                volumeIndexByLabel.set(key, volumes.length);
                lastNumericIndexByVolume.set(key, 0);
                nonNumericStreakByVolume.set(key, 0);
                volumes.push({
                    name: chapter.volumeLabel ? `Volume ${chapter.volumeLabel}` : 'Capítulos',
                    slug: this.slugifyString(chapter.volumeLabel ? `Volume ${chapter.volumeLabel}` : 'Capítulos'),
                    chapters: []
                });
            }

            const volume = volumes[volumeIndexByLabel.get(key)];

            // Sem número real (Prólogo/Posfácio/Interlúdio/Extra sem dígito): ancora
            // logo depois do último capítulo numerado visto até aqui. Vários seguidos
            // (ex: Interlúdio, Extra 1, Extra 2...) usam um contador de sequência pra
            // não colidir entre si — reseta assim que aparece um número de novo.
            let index = chapter.realIndex;
            if (index === null) {
                const streak = nonNumericStreakByVolume.get(key) + 1;
                nonNumericStreakByVolume.set(key, streak);
                index = lastNumericIndexByVolume.get(key) + streak * 0.00001;
            } else {
                nonNumericStreakByVolume.set(key, 0);
                lastNumericIndexByVolume.set(key, index);
            }

            volume.chapters.push({
                capitulo: chapter.capitulo,
                name: chapter.name,
                url: chapter.url,
                index,
                volume: chapter.volumeLabel,
            });
        });

        volumes.forEach(volume => volume.chapters.sort((a, b) => a.index - b.index));

        return { volumes, orderedChapterUrls: rawChapters.map(c => c.url) };
    }

    // Ponteiro leve (sem conteúdo) de onde cada capítulo está na REST API, calculado
    // pela posição real dele na obra — não pelo número no slug, que pode resetar por
    // volume (Vol.1 Cap.1..50, Vol.2 Cap.1..30...) e não bateria com a página certa.
    async cacheChapterPositions(slug, orderedChapterUrls) {
        const { data: categories } = await axiosInstance.get(`${this.wpApiUrl}/categories`, {
            params: { slug }
        });

        const category = categories[0];
        if (!category) return;

        orderedChapterUrls.forEach((url, index) => {
            const page = Math.ceil((index + 1) / 100);
            cache.set(cacheKeys.chapterPosition(this.name, url), { categoryId: category.id, page }, cacheTTL.chapters);
        });
    }

    parseTitle($) {
        const titleElement = $('.entry-title');
        if (titleElement.length) {
            return titleElement.text().trim();
        }
        return null;
    }

    parseCover($) {
        const coverElement = $('.bigcontent .thumb img, .thumbook img, meta[property="og:image"]');
        if (coverElement.length > 0) {
            const cover = coverElement.first();
            return cover.attr('data-src') || cover.attr('src') || cover.attr('content');
        }
        return null;
    }

    parseAuthors($) {
        const meta = {};
        $('.ninfo .info-content .spe span').each((index, element) => {
            const txt = $(element).text().replace(/\s+/g, ' ').trim();
            const [key, ...rest] = txt.split(':');
            if (rest.length) {
                meta[key.trim()] = rest.join(':').trim();
            }
        });

        const authorField = meta['Autor'] || meta['Author'] || '';
        return authorField ? authorField.split(',').map(a => a.trim()).filter(Boolean) : [];
    }

// Limpeza compartilhada entre o pré-aquecimento (fetchVolumesFromApi) e a busca
    // avulsa (downloadChapterBody) — mesmo resultado nos dois caminhos.
    cleanChapterHtml(rawHtml) {
        const $ = cheerio.load(rawHtml);

        $('img').each(function () {
            const src = $(this).attr('src');
            const alt = $(this).attr('alt') || '';

            for (let attribute of this.attributes) {
                $(this).removeAttr(attribute.name);
            }

            $(this).attr('src', src);
            $(this).attr('alt', alt);
            $(this).addClass('mx-auto');
        });

        $('.epcontent.entry-content div.kln, .epcontent.entry-content div.klnmid').remove();
        $('p').removeAttr('style').removeAttr('data-mce-style');

        return $('body').html().replace(/"/g, "'").replace(/\n/g, '');
    }

    async downloadChapterBody(url, processImage = false) {
        const fullUrl = this.getFullUrl(url);

        if (!processImage) {
            const cached = cache.get(cacheKeys.chapterContent(this.name, fullUrl, false));
            if (cached) return cached;
        }

        // Sabemos (via readNovelInfo) em qual página da REST API esse capítulo cai —
        // busca a página inteira (100 capítulos + conteúdo), cacheia todos de uma vez
        // (os vizinhos, prováveis próximas leituras, ficam prontos também).
        const position = cache.get(cacheKeys.chapterPosition(this.name, fullUrl));
        if (position) {
            const result = await this.fetchAndCacheChapterPage(position.categoryId, position.page, fullUrl);
            if (result) {
                return processImage ? this.finalizeChapterBody(result.content) : result;
            }
        }

        // Fallback: busca exata por slug (sempre certo, só não aproveita vizinhos).
        // Usado quando a obra nunca passou por readNovelInfo, ou quando a página
        // estimada não continha esse capítulo (numeração pode ter furos/exceções).
        const slug = this.extractSlug(fullUrl);
        const { data: posts } = await axiosInstance.get(`${this.wpApiUrl}/posts`, {
            params: { slug }
        });

        const post = posts[0];
        if (!post) {
            throw new Error(`Capítulo não encontrado para o slug "${slug}"`);
        }

        const content = this.cleanChapterHtml(post.content.rendered);
        cache.set(cacheKeys.chapterContent(this.name, fullUrl, false), { content }, cacheTTL.chapterContent);

        return processImage ? this.finalizeChapterBody(content) : { content };
    }

    // Busca uma página de 100 capítulos da REST API e cacheia o conteúdo de cada um
    // individualmente — devolve o resultado do capítulo alvo, ou null se ele não
    // estava nessa página (numeração irregular fez a estimativa errar).
    async fetchAndCacheChapterPage(categoryId, page, targetUrl) {
        const { data: posts } = await axiosInstance.get(`${this.wpApiUrl}/posts`, {
            params: { categories: categoryId, per_page: 100, page, orderby: 'date', order: 'asc' }
        });

        let targetResult = null;
        posts.forEach(post => {
            const result = { content: this.cleanChapterHtml(post.content.rendered) };
            cache.set(cacheKeys.chapterContent(this.name, post.link, false), result, cacheTTL.chapterContent);
            if (post.link === targetUrl) targetResult = result;
        });

        return targetResult;
    }

    async finalizeChapterBody(content) {
        const processContent = await this.processImagesInContent(content);
        return { content: processContent.replace(/"/g, "'").replace(/\n/g, '') };
    }

    async getLatestReleases() {
        try {
            const { data } = await axiosInstance.get(`${this.baseUrl}/series/?status=&type=&order=update`);
            const $ = cheerio.load(data);
            const latestReleases = [];

            $('.listupd .maindet').each((index, element) => {
                const url = $(element).find('.mdthumb a').attr('href');
                const imageUrl = $(element).find('.mdthumb img').attr('src');
                const title = $(element).find('.mdinfo h2 a').text().trim();
                const chapter = $(element).find('.nchapter a').text().trim();

                if (url && title && chapter) {
                    latestReleases.push({
                        url,
                        title,
                        chapter,
                        imageUrl
                    });
                }
            });

            return latestReleases;
        } catch (error) {
            console.error('Error getting latest releases:', error.message);
            throw error;
        }
    }
}

module.exports = new CentraNovelProvider();
