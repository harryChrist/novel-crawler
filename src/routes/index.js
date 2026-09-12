const express = require('express');
const cache = require('@/utils/cache');
const TTL = require('@/utils/cacheConfig');
const cacheKeys = require('@/utils/cacheKeys');

module.exports = (providers) => {
    const router = express.Router();

    const findProviderByUrl = (url) => {
        const objectProviders = Object.values(providers);
        return objectProviders.find(provider => url.startsWith(provider.baseUrl));
    }

    // Cada provider pode sobrescrever o TTL padrão por rota (ex: `this.cacheTTL = { chapters: 0 }`
    // no construtor pra desligar cache numa rota específica, já que nem todo source ganha
    // tanto com cache — alguns buscam direto numa url especifica, outros puxam listas grandes).
    const resolveTTL = (provider, key) => provider.cacheTTL?.[key] ?? TTL[key];

    const cachedCall = async (cacheKey, ttl, fn) => {
        if (!ttl) {
            return { value: await fn(), hit: undefined };
        }
        return cache.getOrSet(cacheKey, ttl, fn);
    };

    // Loga o resultado final de uma requisição: sucesso (com resumo) ou falha.
    const logResult = ({ route, providerName, params, cacheHit, startedAt, error, summary }) => {
        const ms = Date.now() - startedAt;
        const cacheTag = cacheHit === undefined ? 'OFF' : (cacheHit ? 'HIT' : 'MISS');
        const paramsTag = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');

        if (error) {
            console.error(`[${providerName || '?'}] ${route} FAIL ${ms}ms cache=${cacheTag} ${paramsTag} -> ${error.message}`);
        } else {
            console.log(`[${providerName || '?'}] ${route} OK ${ms}ms cache=${cacheTag} ${paramsTag} -> ${summary}`);
        }
    };

    // Rota para buscar novels
    router.get('/search', async (req, res) => {
        const { type, q, fresh } = req.query;
        const startedAt = Date.now();
        if (!q || !type) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        try {
            const provider = providers[type.toLowerCase()];
            if (!provider) {
                logResult({ route: '/search', providerName: type, params: { q }, startedAt, error: new Error('Provider not found') });
                return res.status(404).json({ error: 'Provider not found' });
            }

            const cacheKey = cacheKeys.search(provider.name, q);
            const ttl = resolveTTL(provider, 'search');
            if (fresh) cache.delete(cacheKey);
            const { value: results, hit } = await cachedCall(cacheKey, ttl, () => provider.searchNovel(q));

            logResult({ route: '/search', providerName: provider.name, params: { q }, cacheHit: hit, startedAt, summary: `${results.length} resultados` });
            res.status(200).json(results);
        } catch (error) {
            logResult({ route: '/search', providerName: type, params: { q }, startedAt, error });
            res.status(500).json({ error: error.message });
        }
    });

    // Rota para obter informações de uma novel
    router.get('/chapters', async (req, res) => {
        const { type, url, fresh } = req.query;
        const startedAt = Date.now();
        try {
            let provider;
            if (type) {
                provider = providers[type.toLowerCase()];
            } else {
                provider = findProviderByUrl(url);
            }
            if (!provider) {
                logResult({ route: '/chapters', providerName: type, params: { url }, startedAt, error: new Error('Provider not found') });
                return res.status(404).json({ error: 'Provider not found' });
            }

            const cacheKey = cacheKeys.chapters(provider.name, url);
            const ttl = resolveTTL(provider, 'chapters');
            if (fresh) cache.delete(cacheKey);
            const { value: results, hit } = await cachedCall(cacheKey, ttl, () => provider.readNovelInfo(url));

            logResult({ route: '/chapters', providerName: provider.name, params: { url }, cacheHit: hit, startedAt, summary: `${results.chapters} capítulos, ${results.volumes} volumes` });
            res.status(200).json(results);
        } catch (error) {
            logResult({ route: '/chapters', providerName: type, params: { url }, startedAt, error });
            res.status(500).json({ error: error.message });
        }
    });

    // Rota para obter o conteúdo de um capítulo
    router.get('/chapter-content', async (req, res) => {
        const { type, url, image, fresh } = req.query;
        const startedAt = Date.now();
        try {
            let provider;
            if (type) {
                provider = providers[type.toLowerCase()];
            } else {
                provider = findProviderByUrl(url);
            }
            if (!provider) {
                logResult({ route: '/chapter-content', providerName: type, params: { url, image }, startedAt, error: new Error('Provider not found') });
                return res.status(404).json({ error: 'Provider not found' });
            }

            const cacheKey = cacheKeys.chapterContent(provider.name, url, image);
            const ttl = resolveTTL(provider, 'chapterContent');
            if (fresh) cache.delete(cacheKey);
            const { value: results, hit } = await cachedCall(cacheKey, ttl, () => provider.downloadChapterBody(url, Boolean(image)));

            logResult({ route: '/chapter-content', providerName: provider.name, params: { url, image }, cacheHit: hit, startedAt, summary: `${results.content.length} chars` });
            res.status(200).json(results);
        } catch (error) {
            logResult({ route: '/chapter-content', providerName: type, params: { url, image }, startedAt, error });
            res.status(500).json({ error: error.message });
        }
    });

    router.get('/providers', (req, res) => {
        const startedAt = Date.now();
        const providerList = Object.values(providers).map(config => ({
            name: config.name,
            language: config.language,
            baseUrl: config.baseUrl,
        }));

        logResult({ route: '/providers', params: {}, startedAt, summary: `${providerList.length} providers` });
        res.status(200).json(providerList);
    });

    // Rota para obter os últimos lançamentos
    router.get('/latest', async (req, res) => {
        const { type, fresh } = req.query;
        const startedAt = Date.now();
        try {
            const provider = providers[type.toLowerCase()];
            if (!provider) {
                logResult({ route: '/latest', providerName: type, params: {}, startedAt, error: new Error('Provider not found') });
                return res.status(404).json({ error: 'Provider not found' });
            }

            const cacheKey = cacheKeys.latest(provider.name);
            const ttl = resolveTTL(provider, 'latest');
            if (fresh) cache.delete(cacheKey);
            const { value: results, hit } = await cachedCall(cacheKey, ttl, () => provider.getLatestReleases());

            logResult({ route: '/latest', providerName: provider.name, params: {}, cacheHit: hit, startedAt, summary: `${results.length} lançamentos` });
            res.status(200).json(results);
        } catch (error) {
            logResult({ route: '/latest', providerName: type, params: {}, startedAt, error });
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};
