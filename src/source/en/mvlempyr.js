const axios = require('axios');
const cheerio = require('cheerio');
const BaseProvider = require('@/template/BaseProvider');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

class MvlEmpyrProvider extends BaseProvider {
    constructor() {
        super('mvlempyr', 'https://www.mvlempyr.io', 'novel');
        this.apiBase = 'https://chap.heliosarchive.online/wp-json/wp/v2';
    }

    // tag_id = 7^novel_code mod 1999999997 — vínculo entre obra e taxonomia de capítulos
    tagIdForNovelCode(novelCode) {
        let base = 7n;
        let exp = BigInt(novelCode);
        const mod = 1999999997n;
        let result = 1n;
        base %= mod;
        while (exp > 0n) {
            if (exp & 1n) result = (result * base) % mod;
            exp >>= 1n;
            base = (base * base) % mod;
        }
        return Number(result);
    }

    extractSlugFromUrl(url) {
        const path = new URL(url, this.baseUrl).pathname;
        const segments = path.split('/').filter(Boolean);
        return segments[segments.length - 1];
    }

    toFrontendUrl(urlOrPath) {
        const { pathname } = new URL(urlOrPath, this.baseUrl);
        return `${this.baseUrl}${pathname}`;
    }

    buildCoverUrl(novelCode) {
        return `https://assets.mvlempyr.app/images/600/${novelCode}.webp`;
    }

    async fetchNovels(params) {
        const { data } = await axios.get(`${this.apiBase}/mvl-novels`, { params });
        return data;
    }

    mapNovelItem(item) {
        return {
            url: `${this.baseUrl}/novel/${item.slug}`,
            title: item.name,
            chapter: item['total-chapters'] != null ? String(item['total-chapters']) : null,
            imageUrl: this.buildCoverUrl(item['novel-code']),
            rating: item['average-review'] ?? null,
            genre: item.genre || [],
        };
    }

    async searchNovel(query) {
        try {
            // O parâmetro `search` da API não filtra nada nesse post type (testado, sempre volta vazio),
            // então baixamos o catálogo inteiro (rápido, ~0.6s pra 12k itens) e filtramos aqui.
            const novels = await this.fetchNovels({ per_page: 15000 });
            const needle = query.toLowerCase();
            return novels
                .filter(item =>
                    item.name?.toLowerCase().includes(needle) ||
                    item['associated-names']?.toLowerCase().includes(needle)
                )
                .map(item => this.mapNovelItem(item));
        } catch (error) {
            console.error('Erro ao buscar o conteúdo:', error.message);
            throw error;
        }
    }

    async readNovelInfo(novelUrl) {
        try {
            const slug = this.extractSlugFromUrl(novelUrl);
            const novels = await this.fetchNovels({ slug });
            const novel = novels[0];
            if (!novel) {
                throw new Error(`Obra não encontrada para o slug "${slug}"`);
            }

            const chapters = await this.fetchChapters(novel['novel-code']);

            const volumes = [{
                name: 'Chapters',
                slug: this.slugifyString('Chapters'),
                chapters,
            }];

            return {
                title: novel.name,
                coverUrl: this.buildCoverUrl(novel['novel-code']),
                author: novel['author-name'] ? [novel['author-name']] : [],
                titles: novel['associated-names'] ? novel['associated-names'].split(',').map(t => t.trim()).filter(Boolean) : [novel.name],
                genres: novel.genre || [],
                synopsis: novel['synopsis-text'] || '',
                volumes: volumes.length,
                data: volumes,
                chapters: chapters.length,
            };
        } catch (error) {
            console.error('Erro ao buscar os capítulos:', error.message);
            throw error;
        }
    }

    async fetchChapters(novelCode) {
        const tagId = this.tagIdForNovelCode(novelCode);
        const perPage = 500;

        // `total-chapters` do catálogo pode estar desatualizado (visto na prática: catálogo
        // dizia 84, existiam 94 posts de verdade) — usamos o X-WP-Total real da 1ª página.
        const firstPage = await axios.get(`${this.apiBase}/posts`, {
            params: { tags: tagId, per_page: perPage, page: 1 }
        });
        const totalPages = Math.max(1, Math.ceil(Number(firstPage.headers['x-wp-total'] || firstPage.data.length) / perPage));

        const pageRequests = [Promise.resolve(firstPage)];
        for (let page = 2; page <= totalPages; page++) {
            pageRequests.push(
                axios.get(`${this.apiBase}/posts`, {
                    params: { tags: tagId, per_page: perPage, page }
                })
            );
        }

        const responses = await Promise.all(pageRequests);
        const posts = responses.flatMap(response => response.data);

        return posts
            .map(post => ({
                capitulo: `Chapter ${post.acf.chapter_number}`,
                name: post.acf.ch_name || `Chapter ${post.acf.chapter_number}`,
                url: `${this.baseUrl}/chapter/${post.acf.novel_code}-${post.acf.chapter_number}`,
                index: post.acf.chapter_number,
                volume: null,
            }))
            .sort((a, b) => a.index - b.index);
    }

    async downloadChapterBody(url, processImage = false) {
        const chapterUrl = this.toFrontendUrl(url);
        const { data } = await axios.get(chapterUrl, { headers: HEADERS });
        const $ = cheerio.load(data);

        $('#chapter p').removeAttr('style').removeAttr('class');

        let chapterContent = $('#chapter').html();
        if (!chapterContent) {
            throw new Error(`Conteúdo do capítulo não encontrado em "${chapterUrl}"`);
        }

        if (processImage) {
            let processContent = await this.processImagesInContent(chapterContent);
            return { content: processContent.replace(/"/g, "'").replace(/\n/g, '') };
        }
        return { content: chapterContent.replace(/"/g, "'").replace(/\n/g, '') };
    }

    async getLatestReleases() {
        try {
            const novels = await this.fetchNovels({ orderby: 'date', order: 'desc', per_page: 20 });
            return novels.map(item => ({
                url: `${this.baseUrl}/novel/${item.slug}`,
                title: item.name,
                chapter: item['total-chapters'] != null ? String(item['total-chapters']) : null,
                imageUrl: this.buildCoverUrl(item['novel-code']),
            }));
        } catch (error) {
            console.error('Error getting latest releases:', error.message);
            throw error;
        }
    }
}

module.exports = new MvlEmpyrProvider();
