const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');

// =========================
// MANUALLY LOAD .env FILE
// =========================
const envPath = path.join(__dirname, '.env');
console.log('🔍 Loading .env from:', envPath);

if (fs.existsSync(envPath)) {
    console.log('✅ .env file found');
    let content = fs.readFileSync(envPath, 'utf8');
    content = content.replace(/^\uFEFF/, '');
    content.split('\n').forEach(line => {
        if (line.trim() && !line.startsWith('#')) {
            const [key, ...valueParts] = line.split('=');
            const value = valueParts.join('=').trim();
            if (key.trim()) {
                const cleanValue = value.replace(/^["']|["']$/g, '');
                process.env[key.trim()] = cleanValue;
            }
        }
    });
} else {
    console.log('❌ .env file NOT found at:', envPath);
}

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// DATABASE CONNECTIONS
// =========================

// 1. Miget PostgreSQL (for ratings/favorites)
let migetDb;

try {
    const url = new URL(process.env.DATABASE_URL);
    console.log('🔍 Miget Host:', url.hostname);
    console.log('🔍 Miget Port:', url.port);
    console.log('🔍 Miget Database:', url.pathname.substring(1));

    migetDb = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
    });
    console.log('✅ Miget PostgreSQL connection pool created');
} catch (error) {
    console.error('❌ Error creating Miget PostgreSQL connection pool:', error.message);
    process.exit(1);
}

// 2. Neon PostgreSQL (for performer data)
let neonDb;

if (process.env.NEON_DATABASE_URL) {
    try {
        const neonUrl = new URL(process.env.NEON_DATABASE_URL);
        console.log('🔍 Neon Host:', neonUrl.hostname);
        console.log('🔍 Neon Database:', neonUrl.pathname.substring(1));

        neonDb = new Pool({
            connectionString: process.env.NEON_DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
            max: 10,
        });
        console.log('✅ Neon PostgreSQL connection pool created');
    } catch (error) {
        console.error('❌ Error creating Neon PostgreSQL connection pool:', error.message);
        console.log('⚠️ Falling back to local JSON data');
        neonDb = null;
    }
} else {
    console.log('⚠️ NEON_DATABASE_URL not set - using local JSON data');
    neonDb = null;
}

// =========================
// DATABASE HELPER FUNCTIONS
// =========================

async function queryMiget(sql, params = []) {
    try {
        const result = await migetDb.query(sql, params);
        return result;
    } catch (error) {
        console.error('❌ Miget query error:', error.message);
        throw error;
    }
}

async function queryNeon(sql, params = []) {
    if (!neonDb) return [];
    try {
        const result = await neonDb.query(sql, params);
        return result.rows;
    } catch (error) {
        console.error('❌ Neon query error:', error.message);
        return [];
    }
}

async function getUserData() {
    try {
        const ratings = await queryMiget('SELECT performer_id, rating FROM performer_ratings');
        const favPerformers = await queryMiget('SELECT performer_id FROM favorite_performers');
        const favScenes = await queryMiget('SELECT scene_id FROM favorite_scenes');
        
        return {
            performerRatings: ratings.rows.reduce((acc, row) => {
                acc[row.performer_id] = row.rating;
                return acc;
            }, {}),
            favoritePerformers: favPerformers.rows.map(row => row.performer_id),
            favoriteScenes: favScenes.rows.map(row => row.scene_id)
        };
    } catch (error) {
        console.error('❌ Error getting user data:', error.message);
        return {
            performerRatings: {},
            favoritePerformers: [],
            favoriteScenes: []
        };
    }
}

// =========================
// HELPER: Parse Aliases
// =========================
function parseAliases(aliases) {
    if (!aliases) return [];
    if (Array.isArray(aliases)) return aliases;
    if (typeof aliases === 'string') {
        try {
            const parsed = JSON.parse(aliases);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }
    return [];
}

// =========================
// NEON QUERY FUNCTIONS - Define BEFORE routes
// =========================

async function getPerformerById(id) {
    const result = await queryNeon('SELECT * FROM performers WHERE id = $1', [id]);
    if (result.length === 0) return null;
    return result[0];
}

async function getPerformerScenes(performerId, page = 1, perPage = 24) {
    const offset = (page - 1) * perPage;
    
    const countResult = await queryNeon(
        'SELECT COUNT(*) FROM performer_scenes WHERE performer_id = $1',
        [performerId]
    );
    const total = parseInt(countResult[0]?.count || 0);
    
    const scenes = await queryNeon(`
        SELECT s.* 
        FROM scenes s
        JOIN performer_scenes ps ON s.id = ps.scene_id
        WHERE ps.performer_id = $1
        LIMIT $2 OFFSET $3
    `, [performerId, perPage, offset]);
    
    return {
        scenes: scenes.map(s => ({
            ...s,
            images: s.images ? JSON.parse(s.images) : []
        })),
        total,
        totalPages: Math.ceil(total / perPage),
        currentPage: page
    };
}

async function searchPerformers(term) {
    return await queryNeon(
        "SELECT * FROM performers WHERE name ILIKE $1 OR aliases ILIKE $1 LIMIT 20",
        [`%${term}%`]
    );
}

async function getStudio(id) {
    const result = await queryNeon('SELECT * FROM studios WHERE id = $1', [id]);
    return result.length > 0 ? result[0] : null;
}

async function getStudioScenes(studioId, page = 1, perPage = 24) {
    const offset = (page - 1) * perPage;
    
    const countResult = await queryNeon(
        'SELECT COUNT(*) FROM scenes WHERE studio_id = $1',
        [studioId]
    );
    const total = parseInt(countResult[0]?.count || 0);
    
    const scenes = await queryNeon(`
        SELECT * FROM scenes 
        WHERE studio_id = $1
        LIMIT $2 OFFSET $3
    `, [studioId, perPage, offset]);
    
    return {
        scenes: scenes.map(s => ({
            ...s,
            images: s.images ? JSON.parse(s.images) : []
        })),
        total,
        totalPages: Math.ceil(total / perPage),
        currentPage: page
    };
}

// =========================
// VIEW ENGINE SETUP
// =========================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// =========================
// MIDDLEWARE
// =========================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// DEBUGGING
// =========================
console.log('🔍 === DEBUGGING START ===');
console.log('🔍 DATABASE_URL exists?', !!process.env.DATABASE_URL);
console.log('🔍 NEON_DATABASE_URL exists?', !!process.env.NEON_DATABASE_URL);
console.log('🔍 NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('🔍 PORT:', PORT);
console.log('🔍 === DEBUGGING END ===');

// =========================
// API ROUTES
// =========================

app.post('/api/rate/performer', async (req, res) => {
    const { performerId, rating } = req.body;
    try {
        await queryMiget(
            `INSERT INTO performer_ratings (performer_id, rating, updated_at) 
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (performer_id) DO UPDATE SET rating = $2, updated_at = CURRENT_TIMESTAMP`,
            [performerId, rating]
        );
        res.json({ success: true, rating });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/favorite/performer', async (req, res) => {
    const { performerId } = req.body;
    try {
        const result = await queryMiget('SELECT performer_id FROM favorite_performers WHERE performer_id = $1', [performerId]);
        if (result.rows.length > 0) {
            await queryMiget('DELETE FROM favorite_performers WHERE performer_id = $1', [performerId]);
            res.json({ success: true, favorited: false });
        } else {
            await queryMiget('INSERT INTO favorite_performers (performer_id) VALUES ($1)', [performerId]);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/favorite/scene', async (req, res) => {
    const { sceneId } = req.body;
    try {
        const result = await queryMiget('SELECT scene_id FROM favorite_scenes WHERE scene_id = $1', [sceneId]);
        if (result.rows.length > 0) {
            await queryMiget('DELETE FROM favorite_scenes WHERE scene_id = $1', [sceneId]);
            res.json({ success: true, favorited: false });
        } else {
            await queryMiget('INSERT INTO favorite_scenes (scene_id) VALUES ($1)', [sceneId]);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================
// SEARCH STUDIOS API
// =========================
app.get('/api/search/studios', async (req, res) => {
    const query = req.query.q || '';
    try {
        let sql = `
            SELECT DISTINCT studio_name as name, COUNT(*) as scene_count
            FROM scenes 
            WHERE studio_name IS NOT NULL 
              AND studio_name != ''
              AND studio_name != 'null'
              AND studio_name != 'undefined'
        `;
        let params = [];
        if (query && query.length >= 2) {
            sql += ` AND LOWER(studio_name) LIKE LOWER($1)`;
            params.push(`%${query}%`);
        }
        sql += ` GROUP BY studio_name ORDER BY studio_name`;
        const studios = await queryNeon(sql, params);
        res.json({ studios: studios });
    } catch (error) {
        console.error('❌ Studio search error:', error.message);
        res.json({ studios: [] });
    }
});

// =========================
// WEB ROUTES
// =========================

app.get('/', (req, res) => {
    res.render('index', {
        title: 'Performer Viewer',
        performers: [],
        searchTerm: '',
        error: null
    });
});

app.post('/search', async (req, res) => {
    const { searchTerm } = req.body;
    if (!searchTerm || searchTerm.trim().length < 2) {
        return res.render('index', {
            title: 'Performer Viewer',
            performers: [],
            searchTerm,
            error: 'Please enter at least 2 characters'
        });
    }
    try {
        const userData = await getUserData();
        const searchResults = await searchPerformers(searchTerm.trim());
        if (searchResults.length === 0) {
            return res.render('index', {
                title: 'Performer Viewer',
                performers: [],
                searchTerm,
                error: 'No performers found'
            });
        }
        const performers = searchResults.map(p => ({
            id: p.id,
            name: p.name,
            gender: p.gender,
            age: p.age,
            height: p.height,
            scene_count: parseInt(p.scene_count) || 0,
            country: p.country,
            ethnicity: p.ethnicity,
            aliases: parseAliases(p.aliases),
            is_favorite: p.is_favorite === 'true' || p.is_favorite === true,
            images: p.images ? JSON.parse(p.images) : [],
            rating: userData.performerRatings[p.id] || null,
            isFavorited: userData.favoritePerformers.includes(p.id)
        }));
        res.render('index', {
            title: 'Performer Viewer',
            performers: performers,
            searchTerm,
            error: null
        });
    } catch (error) {
        console.error('❌ Search error:', error.message);
        res.render('index', {
            title: 'Performer Viewer',
            performers: [],
            searchTerm,
            error: 'Error searching for performers. Please try again.'
        });
    }
});


// =========================
// ADVANCED SEARCH PAGE - SERVER RENDERED (Direct DB Query)
// =========================
app.get('/advanced-search', async (req, res) => {
    const studios = req.query.studios ? req.query.studios.split(',').filter(s => s) : [];
    const match = req.query.match || 'any';
    const minScenes = parseInt(req.query.minScenes) || 0;
    const minScenesEnabled = req.query.minScenesEnabled !== 'false';
    const cupsize = req.query.cupsize ? (Array.isArray(req.query.cupsize) ? req.query.cupsize : [req.query.cupsize]) : [];
    const tier = req.query.tier || '';
    const favorite = req.query.favorite || '';
    const page = parseInt(req.query.page) || 1;
    const perPage = 50;
    
    try {
        // =========================
        // BUILD THE QUERY DIRECTLY
        // =========================
        const userData = await getUserData();
        const studioNames = studios;
        const offset = (page - 1) * perPage;
        const limit = perPage;
        const minScenesInt = minScenesEnabled ? minScenes : 0;
        
        let params = [];
        let paramIndex = 1;
        let whereConditions = [];
        let havingConditions = [];
        let havingParams = [];
        
        // Studio conditions
        if (studioNames.length > 0) {
            if (match === 'any') {
                const studioConditions = studioNames.map(name => {
                    return `LOWER(s.studio_name) = LOWER($${paramIndex++})`;
                });
                studioNames.forEach(name => params.push(name));
                whereConditions.push(`(${studioConditions.join(' OR ')})`);
            } else {
                whereConditions.push(`s.studio_name IS NOT NULL AND s.studio_name != ''`);
                
                const havingStartIndex = paramIndex;
                studioNames.forEach((name, idx) => {
                    const pIdx = havingStartIndex + idx;
                    havingConditions.push(`COUNT(DISTINCT CASE WHEN LOWER(s.studio_name) = LOWER($${pIdx}) THEN s.studio_name END) = 1`);
                    havingParams.push(name);
                });
                paramIndex += studioNames.length;
                params = params.concat(havingParams);
            }
        }
        
        // Cupsize condition
        if (cupsize && cupsize.length > 0) {
            const hasOther = cupsize.includes('OTHER');
            const specificSizes = cupsize.filter(c => c !== 'OTHER');
            
            let cupsizeConditions = [];
            
            if (specificSizes.length > 0) {
                const sizeConditions = specificSizes.map(c => {
                    return `p.cupsize = $${paramIndex++}`;
                });
                specificSizes.forEach(c => params.push(c));
                cupsizeConditions.push(`(${sizeConditions.join(' OR ')})`);
            }
            
            if (hasOther) {
                const standardSizes = ['A', 'B', 'C', 'D', 'DD', 'DDD', 'E', 'F', 'G', 'H'];
                const standardConditions = standardSizes.map(c => {
                    return `p.cupsize = $${paramIndex++}`;
                });
                standardSizes.forEach(c => params.push(c));
                
                cupsizeConditions.push(
                    `(p.cupsize IS NULL OR p.cupsize NOT IN (${standardSizes.map((_, idx) => `$${paramIndex - standardSizes.length + idx}`).join(',')}))`
                );
            }
            
            if (cupsizeConditions.length > 0) {
                whereConditions.push(`(${cupsizeConditions.join(' OR ')})`);
            }
        }
        
        // Favorite filter (Neon)
        if (favorite === 'true') {
            whereConditions.push(`p.is_favorite = true`);
        } else if (favorite === 'false') {
            whereConditions.push(`(p.is_favorite = false OR p.is_favorite IS NULL)`);
        }
        
        // Build the query
        let performerQuery = '';
        let queryParams = [];
        let whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // CASE 1: No studios, just minScenes
        if (studioNames.length === 0 && minScenesInt > 0) {
            performerQuery = `
                WITH wow_counts AS (
                    SELECT performer, COUNT(*) as wow_count
                    FROM wow_videos
                    WHERE performer IS NOT NULL AND performer != ''
                    GROUP BY performer
                )
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    COALESCE(wc.wow_count, 0) as wow_scene_count,
                    0 as studio_count
                FROM performers p
                LEFT JOIN wow_counts wc ON p.name = wc.performer
                ${whereClause}
                ${whereClause ? 'AND' : 'WHERE'} COALESCE(wc.wow_count, 0) >= $${paramIndex}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                         wc.wow_count
            `;
            queryParams = [...params, minScenesInt];
        }
        // CASE 2: Studios AND minScenes
        else if (studioNames.length > 0 && minScenesInt > 0) {
            performerQuery = `
                WITH wow_counts AS (
                    SELECT performer, COUNT(*) as wow_count
                    FROM wow_videos
                    WHERE performer IS NOT NULL AND performer != ''
                    GROUP BY performer
                )
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    COALESCE(wc.wow_count, 0) as wow_scene_count,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                LEFT JOIN wow_counts wc ON p.name = wc.performer
                ${whereClause}
                ${whereClause ? 'AND' : 'WHERE'} COALESCE(wc.wow_count, 0) >= $${paramIndex}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                         wc.wow_count
                ${havingConditions.length > 0 ? `HAVING ${havingConditions.join(' AND ')}` : ''}
                ${match === 'all' && studioNames.length > 0 ? ` AND COUNT(DISTINCT s.studio_name) >= ${studioNames.length}` : ''}
                ${match === 'exact' && studioNames.length > 0 ? ` AND COUNT(DISTINCT s.studio_name) = ${studioNames.length}` : ''}
            `;
            queryParams = [...params, minScenesInt];
        }
        // CASE 3: Studios only
        else if (studioNames.length > 0 && minScenesInt === 0) {
            performerQuery = `
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    COUNT(DISTINCT s.studio_name) as studio_count,
                    0 as wow_scene_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                ${whereClause}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize
                ${havingConditions.length > 0 ? `HAVING ${havingConditions.join(' AND ')}` : ''}
                ${match === 'all' && studioNames.length > 0 ? `HAVING COUNT(DISTINCT s.studio_name) >= ${studioNames.length}` : ''}
                ${match === 'exact' && studioNames.length > 0 ? `HAVING COUNT(DISTINCT s.studio_name) = ${studioNames.length}` : ''}
            `;
            queryParams = [...params];
        }
        // CASE 4: No studios, no minScenes
        else {
            performerQuery = `
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    0 as studio_count,
                    0 as wow_scene_count
                FROM performers p
                ${whereClause}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize
            `;
            queryParams = [...params];
        }
        
        console.log('🔍 Advanced search query:', performerQuery);
        console.log('📝 Query params:', queryParams);
        
        // Execute Neon query
        const matchedPerformers = await queryNeon(performerQuery, queryParams);
        
        // Get ratings and favorites from Miget
        const performerIds = matchedPerformers.map(p => p.id);
        let performerRatings = {};
        let favoritePerformers = [];
        let filteredPerformers = matchedPerformers;
        
        if (performerIds.length > 0) {
            const ids = performerIds.map(id => `'${id}'`).join(',');
            
            const ratingsResult = await queryMiget(`SELECT performer_id, rating FROM performer_ratings WHERE performer_id IN (${ids})`);
            ratingsResult.rows.forEach(row => {
                performerRatings[row.performer_id] = row.rating;
            });
            
            const favResult = await queryMiget(`SELECT performer_id FROM favorite_performers WHERE performer_id IN (${ids})`);
            favoritePerformers = favResult.rows.map(row => row.performer_id);
            
            // Filter by rating
            if (tier) {
                const ratingValue = tier.trim().toUpperCase();
                
                if (ratingValue === 'RATED') {
                    filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] !== undefined);
                } else if (ratingValue === 'UNRATED') {
                    filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] === undefined);
                } else if (['S', 'A', 'B', 'C', 'D', 'F', 'U', 'L'].includes(ratingValue)) {
                    filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] === ratingValue);
                }
            }
            
            // Filter by favorite
            if (favorite === 'true' && !favorite.includes('is_favorite')) {
                filteredPerformers = filteredPerformers.filter(p => favoritePerformers.includes(p.id));
            } else if (favorite === 'false' && !favorite.includes('is_favorite')) {
                filteredPerformers = filteredPerformers.filter(p => !favoritePerformers.includes(p.id));
            }
        }
        
        // Paginate
        const total = filteredPerformers.length;
        const totalPages = Math.ceil(total / limit);
        const paginatedPerformers = filteredPerformers.slice(offset, offset + limit);
        
        // Format results
        const formattedResults = paginatedPerformers.map(p => {
            const images = p.images ? JSON.parse(p.images) : [];
            const aliases = parseAliases(p.aliases);
            return {
                id: p.id,
                name: p.name,
                gender: p.gender || '',
                age: p.age || '',
                height: p.height || '',
                scene_count: parseInt(p.scene_count) || 0,
                wow_scene_count: parseInt(p.wow_scene_count) || 0,
                country: p.country || '',
                ethnicity: p.ethnicity || '',
                aliases: aliases,
                cupsize: p.cupsize || null,
                is_favorite: p.is_favorite === 'true' || p.is_favorite === true,
                images: images.slice(0, 1),
                rating: performerRatings[p.id] || null,
                is_favorited: favoritePerformers.includes(p.id),
                studio_count: parseInt(p.studio_count) || 0
            };
        });
        
        // ⭐ Define helper functions for the template
        function getRatingColor(rating) {
            switch(rating) {
                case 'S': return '#ff6b6b';
                case 'A': return '#ff9f43';
                case 'B': return '#feca57';
                case 'C': return '#54a0ff';
                case 'D': return '#5f27cd';
                case 'F': return '#ff4757';
                case 'U': return '#747d8c';
                case 'L': return '#ff6b81';
                default: return '#888';
            }
        }
        
        function buildQueryString(params) {
            const current = new URLSearchParams();
            if (studios.length > 0) current.set('studios', studios.join(','));
            if (match) current.set('match', match);
            if (minScenesEnabled && minScenes > 0) {
                current.set('minScenes', minScenes);
                current.set('minScenesEnabled', 'true');
            }
            if (cupsize.length > 0) current.set('cupsize', cupsize.join(','));
            if (tier) current.set('tier', tier);
            if (favorite) current.set('favorite', favorite);
            Object.keys(params).forEach(key => {
                if (params[key] !== null && params[key] !== undefined) {
                    current.set(key, params[key]);
                }
            });
            return current.toString();
        }
        
        res.render('advanced-search', {
            title: 'Advanced Studio Search',
            studios: studios,
            match: match,
            minScenes: minScenes,
            minScenesEnabled: minScenesEnabled,
            cupsize: cupsize,
            tier: tier,
            favorite: favorite,
            performers: formattedResults,
            total: total,
            currentPage: page,
            totalPages: totalPages,
            hasFilters: studios.length > 0 || cupsize.length > 0 || tier || favorite || (minScenesEnabled && minScenes > 0),
            getRatingColor: getRatingColor,
            buildQueryString: buildQueryString
        });
        
    } catch (error) {
        console.error('❌ Advanced search error:', error.message);
        console.error('   Stack:', error.stack);
        res.render('advanced-search', {
            title: 'Advanced Studio Search',
            studios: studios,
            match: match,
            minScenes: minScenes,
            minScenesEnabled: minScenesEnabled,
            cupsize: cupsize,
            tier: tier,
            favorite: favorite,
            performers: [],
            total: 0,
            currentPage: 1,
            totalPages: 0,
            hasFilters: false,
            error: error.message
        });
    }
});



// =========================
// PERFORMER PROFILE
// =========================
app.get('/performer/:id', async (req, res) => {
    const performerId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const userData = await getUserData();
    
    try {
        const performer = await getPerformerById(performerId);
        if (!performer) {
            return res.status(404).send('Performer not found');
        }
        
        const { scenes, total, totalPages } = await getPerformerScenes(performerId, page, perPage);
        
        const performerObj = {
            id: performer.id,
            name: performer.name,
            gender: performer.gender,
            age: performer.age,
            height: performer.height,
            scene_count: parseInt(performer.scene_count) || total,
            country: performer.country,
            ethnicity: performer.ethnicity,
            aliases: parseAliases(performer.aliases),
            is_favorite: performer.is_favorite === 'true' || performer.is_favorite === true,
            images: performer.images ? JSON.parse(performer.images) : []
        };
        
        const scenesWithUserData = scenes.map(scene => ({
            ...scene,
            isFavorited: userData.favoriteScenes.includes(scene.id)
        }));
        
        res.render('performer', {
            title: performer.name,
            performer: performerObj,
            scenes: scenesWithUserData,
            currentPage: page,
            totalPages: totalPages,
            totalScenes: total,
            performerId: performerId,
            performerRating: userData.performerRatings[performerId] || null,
            isPerformerFavorited: userData.favoritePerformers.includes(performerId)
        });
    } catch (error) {
        console.error('❌ Performer error:', error.message);
        res.status(404).send(`Performer not found: ${error.message}`);
    }
});

// =========================
// DIRECT VIDEO URL ENDPOINT
// =========================
app.get('/api/direct-video', async (req, res) => {
    const { sceneUrl } = req.query;
    
    if (!sceneUrl || !sceneUrl.includes('/videos/')) {
        return res.status(400).json({ error: 'Invalid scene URL' });
    }
    
    try {
        // Fetch the scene HTML to get fresh video URL
        const sceneResponse = await axios.get(sceneUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.wow.xxx/'
            }
        });
        
        const $ = cheerio.load(sceneResponse.data);
        let videoUrl = null;
        
        $('video source').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.includes('get_file')) {
                videoUrl = src;
                return false;
            }
        });
        
        if (!videoUrl) {
            return res.status(404).json({ error: 'Video URL not found' });
        }
        
        // Return the direct video URL
        res.json({ 
            success: true, 
            videoUrl: videoUrl + '?download=true'
        });
        
    } catch (error) {
        console.error('❌ Direct URL error:', error.message);
        res.status(500).json({ error: 'Failed to get video URL' });
    }
});



// =========================
// VIDEO MODE PAGE - WITH SORTING AND SEARCH (FIXED)
// =========================
app.get('/performer/:id/videos', async (req, res) => {
    const performerId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const sortBy = req.query.sort || 'date';
    const searchTerm = req.query.search || '';
    
    try {
        const performer = await getPerformerById(performerId);
        if (!performer) {
            return res.status(404).send('Performer not found');
        }
        
        const performerName = performer.name;
        
        let query = `
            SELECT DISTINCT ON (video720p) 
                performer as performer_name,
                title,
                duration,
                studio,
                url,
                video720p,
                video480p,
                date,
                performers
            FROM wow_videos
            WHERE performer ILIKE $1
              AND video720p IS NOT NULL 
              AND video720p != ''
        `;
        
        const params = [`%${performerName}%`];
        
        if (searchTerm && searchTerm.trim()) {
            query += ` AND (title ILIKE $2 OR studio ILIKE $2 OR performers ILIKE $2)`;
            params.push(`%${searchTerm.trim()}%`);
        }
        
        query += ` ORDER BY video720p`;
        
        console.log(`🔍 Searching for ${performerName} with term: "${searchTerm}"`);
        
        // Execute query
        const allWowVideos = await queryNeon(query, params);
        
        console.log(`📊 Found ${allWowVideos.length} unique wow_videos for ${performerName}`);
        
        // Fix thumbnails and dates
        for (const video of allWowVideos) {
            // Fix thumbnail
            if (!video.thumbnail || video.thumbnail.startsWith('data:image')) {
                let videoId = null;
                
                // Try multiple methods
                if (video.video720p) {
                    const match1 = video.video720p.match(/\/(\d+)_\d+p\.mp4/);
                    if (match1) videoId = match1[1];
                }
                if (!videoId && video.video480p) {
                    const match2 = video.video480p.match(/\/(\d+)_\d+p\.mp4/);
                    if (match2) videoId = match2[1];
                }
                if (!videoId && video.url) {
                    const match3 = video.url.match(/\/videos\/(\d+)/);
                    if (match3) videoId = match3[1];
                }
                
                if (videoId) {
                    const prefix = String(videoId).substring(0, 5);
                    video.thumbnail = `https://img.freesexvideos.xxx/${prefix}000/${videoId}/medium@2x/1.jpg`;
                    console.log(`✅ Generated thumbnail for video ${videoId}`);
                }
            }
            
            // Fix date format for sorting (YYYY-MM-DD)
            if (video.date) {
                const parts = video.date.split('.');
                if (parts.length === 3) {
                    video.dateSort = `${parts[2]}-${parts[1]}-${parts[0]}`;
                } else {
                    video.dateSort = '';
                }
            } else {
                video.dateSort = '';
            }
            
            // Clean up performers string
            if (video.performers) {
                video.performers = video.performers.replace(/\s*;\s*/g, '; ');
            }
        }
        
        // Sort
        if (sortBy === 'date') {
            allWowVideos.sort((a, b) => {
                const dateA = a.dateSort || '';
                const dateB = b.dateSort || '';
                if (!dateA && !dateB) return 0;
                if (!dateA) return 1;
                if (!dateB) return -1;
                return dateB.localeCompare(dateA);
            });
        } else if (sortBy === 'title') {
            allWowVideos.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        } else if (sortBy === 'duration') {
            allWowVideos.sort((a, b) => {
                const durA = a.duration ? parseDuration(a.duration) : 0;
                const durB = b.duration ? parseDuration(b.duration) : 0;
                return durB - durA;
            });
        }
        
        // Paginate
        const totalWowScenes = allWowVideos.length;
        const totalPages = Math.ceil(totalWowScenes / perPage);
        const startIndex = (page - 1) * perPage;
        const endIndex = Math.min(startIndex + perPage, totalWowScenes);
        const paginatedVideos = allWowVideos.slice(startIndex, endIndex);
        
        const performerObj = {
            id: performer.id,
            name: performer.name,
            gender: performer.gender,
            age: performer.age,
            height: performer.height,
            scene_count: parseInt(performer.scene_count) || 0,
            country: performer.country,
            ethnicity: performer.ethnicity,
            aliases: parseAliases(performer.aliases),
            is_favorite: performer.is_favorite === 'true' || performer.is_favorite === true,
            images: performer.images ? JSON.parse(performer.images) : []
        };
        
        res.render('performer-videos', {
            title: `${performer.name} - Videos`,
            performer: performerObj,
            performerId: performerId,
            wowScenes: paginatedVideos,
            totalWowScenes: totalWowScenes,
            currentPage: page,
            totalPages: totalPages,
            perPage: perPage,
            sortBy: sortBy,
            searchTerm: searchTerm
        });
        
    } catch (error) {
        console.error('❌ Video mode error:', error.message);
        console.error('   Query params:', JSON.stringify(params));
        res.status(500).send('Error loading videos');
    }
});

// Helper function to parse duration string to seconds
function parseDuration(duration) {
    if (!duration) return 0;
    if (typeof duration === 'string') {
        if (duration.includes(':')) {
            const parts = duration.split(':');
            if (parts.length === 2) {
                return parseInt(parts[0]) * 60 + parseInt(parts[1]);
            } else if (parts.length === 3) {
                return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
            }
        }
        const match = duration.match(/(\d+)/);
        if (match) return parseInt(match[1]);
    }
    return parseInt(duration) || 0;
}



// =========================
// VIDEO URL ENDPOINT - UPDATED COLUMN NAMES
// =========================
app.get('/api/video/url', async (req, res) => {
    const { sceneUrl } = req.query;
    
    if (!sceneUrl) {
        return res.status(400).json({ error: 'No scene URL provided' });
    }
    
    try {
        // Look up by url - using new column names
        let result = await queryNeon(
            `SELECT video720p, video480p FROM wow_videos WHERE url = $1 OR title ILIKE $1`,
            [sceneUrl]
        );
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Video not found in database' });
        }
        
        // Use video720p as the main video URL
        const videoUrl = result[0].video720p || result[0].video480p || null;
        
        if (!videoUrl) {
            return res.status(404).json({ error: 'No video URL available' });
        }
        
        res.json({ success: true, videoUrl: videoUrl });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// =========================
// DIRECT VIDEO URL ENDPOINT - UPDATED COLUMN NAMES
// =========================
app.get('/api/direct-video', async (req, res) => {
    const { sceneUrl } = req.query;
    
    if (!sceneUrl) {
        return res.status(400).json({ error: 'Invalid scene URL' });
    }
    
    try {
        // Get video URL from database using new column names
        const result = await queryNeon(
            'SELECT video720p, video480p FROM wow_videos WHERE url = $1',
            [sceneUrl]
        );
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        const videoUrl = result[0].video720p || result[0].video480p || null;
        
        if (!videoUrl) {
            return res.status(404).json({ error: 'No video URL available' });
        }
        
        res.json({ 
            success: true, 
            videoUrl: videoUrl + '?download=true'
        });
        
    } catch (error) {
        console.error('❌ Direct URL error:', error.message);
        res.status(500).json({ error: 'Failed to get video URL' });
    }
});

// =========================
// SCENE DETAILS
// =========================
app.get('/scene/:id', async (req, res) => {
    const sceneId = req.params.id;
    const userData = await getUserData();
    
    try {
        const sceneResult = await queryNeon('SELECT * FROM scenes WHERE id = $1', [sceneId]);
        if (sceneResult.length === 0) {
            return res.status(404).send('Scene not found');
        }
        
        const scene = sceneResult[0];
        const performers = await queryNeon(`
            SELECT p.* 
            FROM performers p
            JOIN performer_scenes ps ON p.id = ps.performer_id
            WHERE ps.scene_id = $1
        `, [sceneId]);
        
        const formattedScene = {
            id: scene.id,
            title: scene.title,
            date: scene.date,
            duration: scene.duration,
            studio: scene.studio_id ? { id: scene.studio_id, name: scene.studio_name } : null,
            images: scene.images ? JSON.parse(scene.images) : [],
            performers: performers.map(p => ({ 
                performer: {
                    id: p.id,
                    name: p.name,
                    images: p.images ? JSON.parse(p.images) : []
                }
            }))
        };
        
        res.render('scene', {
            title: scene.title || 'Scene',
            scene: formattedScene,
            isFavorited: userData.favoriteScenes.includes(sceneId)
        });
    } catch (error) {
        console.error('❌ Scene error:', error.message);
        res.status(404).send('Scene not found');
    }
});

// =========================
// STUDIO DETAILS PAGE
// =========================
app.get('/studio/:id', async (req, res) => {
    const studioId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const userData = await getUserData();
    
    try {
        const studio = await getStudio(studioId);
        if (!studio) {
            return res.status(404).send('Studio not found');
        }
        
        const { scenes, total, totalPages } = await getStudioScenes(studioId, page, perPage);
        const performersResult = await queryNeon(`
            SELECT COUNT(DISTINCT ps.performer_id) 
            FROM performer_scenes ps
            JOIN scenes s ON ps.scene_id = s.id
            WHERE s.studio_id = $1
        `, [studioId]);
        const performersCount = parseInt(performersResult[0]?.count || 0);
        
        let studioImage = null;
        if (scenes.length > 0 && scenes[0].images) {
            const images = JSON.parse(scenes[0].images);
            if (images.length > 0) {
                studioImage = images[0].url;
            }
        }
        
        const scenesWithRatings = scenes.map(scene => ({
            ...scene,
            performerRating: null,
            isFavorited: userData.favoriteScenes.includes(scene.id)
        }));
        
        res.render('studio', {
            title: studio.name,
            studioName: studio.name,
            studioId: studio.id,
            studioImage: studioImage,
            totalScenes: total,
            performersCount: performersCount,
            scenes: scenesWithRatings,
            currentPage: page,
            totalPages: totalPages,
            studioId: studioId,
            isFavorite: false
        });
    } catch (error) {
        console.error('❌ Studio error:', error.message);
        res.status(404).send('Studio not found');
    }
});

app.get('/advanced-search', (req, res) => {
    res.render('advanced-search', { title: 'Advanced Studio Search' });
});

app.get('/api/video/url', async (req, res) => {
    const { sceneUrl, quality = '720', download = 'false' } = req.query;
    
    if (!sceneUrl) {
        return res.status(400).json({ error: 'No scene URL provided' });
    }
    
    try {
        let result = await queryNeon(
            'SELECT video_url FROM wow_videos WHERE url = $1 OR title ILIKE $1',
            [sceneUrl]
        );
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        let videoUrl = result[0].video_url;
        
        // If download requested, add download parameters
        if (download === 'true') {
            const videoId = videoUrl.match(/\/(\d+)_/)?.[1] || 'video';
            videoUrl = videoUrl + `?download=true&download_filename=${videoId}.mp4`;
        }
        
        res.json({ success: true, videoUrl: videoUrl });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});


app.get('/api/search/videos', async (req, res) => {
    // =========================
    // DEBUG: Log raw query params
    // =========================
    console.log('🔍 RAW QUERY PARAMS:', req.query);
    
    // =========================
    // GET PARAMETERS WITH FALLBACKS
    // =========================
    let q = req.query.q || '';
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 24;
    const sortBy = req.query.sortBy || 'date';
    
    // =========================
    // FIX: Handle proxy encoding issues
    // =========================
    console.log('🔍 ORIGINAL q:', q);
    
    try {
        // Try to decode if it looks URL-encoded
        if (q.includes('%')) {
            q = decodeURIComponent(q);
            console.log('🔍 DECODED q:', q);
        }
    } catch (e) {
        console.log('⚠️ Decoding failed, using raw value');
    }
    
    // Clean up: Remove duplicate commas and trim
    q = q.replace(/,{2,}/g, ','); // Replace multiple commas with single
    q = q.trim();
    
    console.log('🔍 FINAL q:', q);
    
    const offset = (page - 1) * perPage;
    const limit = perPage;
    
    try {
        let params = [];
        let paramIndex = 1;
        let whereConditions = [];
        
        // =========================
        // BUILD SEARCH CONDITIONS
        // =========================
        if (q && q.trim()) {
            const searchTerms = q.trim().split(/\s*,\s*/).filter(t => t);
            console.log('🔍 SEARCH TERMS:', searchTerms);
            
            if (searchTerms.length > 0) {
                const conditions = [];
                
                for (const term of searchTerms) {
                    const termLower = term.toLowerCase().trim();
                    conditions.push(`(
                        LOWER(w.studio) ILIKE $${paramIndex} OR 
                        LOWER(w.performers) ILIKE $${paramIndex} OR 
                        LOWER(w.title) ILIKE $${paramIndex} OR 
                        LOWER(w.performer) ILIKE $${paramIndex}
                    )`);
                    params.push(`%${termLower}%`);
                    paramIndex++;
                }
                
                if (conditions.length > 0) {
                    whereConditions.push(`(${conditions.join(' AND ')})`);
                }
            }
        }
        
        // =========================
        // RETURN EMPTY IF NO SEARCH TERMS
        // =========================
        if (whereConditions.length === 0) {
            console.log('⚠️ No search terms provided');
            return res.json({
                success: true,
                videos: [],
                total: 0,
                page: page,
                perPage: limit,
                totalPages: 0,
                searchTerm: q
            });
        }
        
        // =========================
        // BUILD THE QUERY
        // =========================
        let query = `
            SELECT DISTINCT ON (w.video720p) 
                w.performer,
                w.title,
                w.duration,
                w.studio,
                w.url,
                w.video720p,
                w.video480p,
                w.date,
                w.performers,
                w.thumbnail
            FROM wow_videos w
            WHERE w.video720p IS NOT NULL 
              AND w.video720p != ''
              AND ${whereConditions.join(' AND ')}
        `;
        
        // Add sorting
        if (sortBy === 'date') {
            query += ` ORDER BY w.video720p, w.date DESC NULLS LAST`;
        } else if (sortBy === 'title') {
            query += ` ORDER BY w.video720p, w.title`;
        } else if (sortBy === 'duration') {
            query += ` ORDER BY w.video720p, 
                CASE 
                    WHEN w.duration LIKE '%:%' THEN 
                        CAST(SPLIT_PART(w.duration, ':', 1) AS INTEGER) * 60 + 
                        CAST(SPLIT_PART(w.duration, ':', 2) AS INTEGER)
                    ELSE CAST(w.duration AS INTEGER)
                END DESC NULLS LAST`;
        } else {
            query += ` ORDER BY w.video720p, w.date DESC NULLS LAST`;
        }
        
        // Add pagination
        query += ` LIMIT $${paramIndex}::int OFFSET $${paramIndex + 1}::int`;
        params.push(limit, offset);
        
        console.log(`🔍 FINAL QUERY:`, query);
        console.log(`📝 QUERY PARAMS:`, params);
        
        // =========================
        // EXECUTE QUERY
        // =========================
        const videos = await queryNeon(query, params);
        
        // Get total count
        let countQuery = `
            SELECT COUNT(DISTINCT w.video720p) as total
            FROM wow_videos w
            WHERE w.video720p IS NOT NULL 
              AND w.video720p != ''
              AND ${whereConditions.join(' AND ')}
        `;
        
        const countParams = params.slice(0, -2);
        const countResult = await queryNeon(countQuery, countParams);
        const total = parseInt(countResult[0]?.total || 0);
        const totalPages = Math.ceil(total / limit);
        
        // =========================
        // GENERATE THUMBNAILS AND FIX DATES
        // =========================
        for (const video of videos) {
            if (!video.thumbnail || video.thumbnail.startsWith('data:image')) {
                let videoId = null;
                if (video.video720p) {
                    const match = video.video720p.match(/\/(\d+)_\d+[pm]\.mp4/);
                    if (match) videoId = match[1];
                }
                if (!videoId && video.video480p) {
                    const match = video.video480p.match(/\/(\d+)_\d+[pm]\.mp4/);
                    if (match) videoId = match[1];
                }
                if (videoId) {
                    const prefix = String(videoId).substring(0, 5);
                    video.thumbnail = `https://img.freesexvideos.xxx/${prefix}000/${videoId}/medium@2x/1.jpg`;
                }
            }
            
            // Fix date format for display
            if (video.date) {
                const parts = video.date.split('.');
                if (parts.length === 3) {
                    video.dateDisplay = `${parts[1]}/${parts[0]}/${parts[2]}`;
                } else {
                    video.dateDisplay = video.date;
                }
            }
        }
        
        // =========================
        // RETURN RESPONSE
        // =========================
        console.log(`✅ Found ${videos.length} videos out of ${total} total`);
        
        res.json({
            success: true,
            videos: videos,
            total: total,
            page: page,
            perPage: limit,
            totalPages: totalPages,
            searchTerm: q,
            sortBy: sortBy
        });
        
    } catch (error) {
        console.error('❌ Global video search error:', error.message);
        console.error('   Stack:', error.stack);
        console.error('   Query params:', JSON.stringify(params));
        res.json({ success: false, error: error.message, videos: [] });
    }
});


app.get('/video-search', async (req, res) => {
    const searchTerm = req.query.q || '';
    const sortBy = req.query.sort || 'date';
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const showFavoritesOnly = req.query.favorites === 'true'; // ⭐ NEW
    
    try {
        // If no search term, just show the empty search page
        if (!searchTerm) {
            return res.render('video-search', { 
                title: 'Video Search',
                searchTerm: '',
                sortBy: sortBy,
                videos: [],
                totalVideos: 0,
                currentPage: 1,
                totalPages: 0,
                perPage: perPage,
                showFavoritesOnly: showFavoritesOnly
            });
        }
        
        // Build the search query
        let params = [];
        let paramIndex = 1;
        let whereConditions = [];
        
        const searchTerms = searchTerm.trim().split(/\s*,\s*/).filter(t => t);
        
        if (searchTerms.length > 0) {
            const conditions = [];
            for (const term of searchTerms) {
                const termLower = term.toLowerCase().trim();
                conditions.push(`(
                    LOWER(w.studio) ILIKE $${paramIndex} OR 
                    LOWER(w.performers) ILIKE $${paramIndex} OR 
                    LOWER(w.title) ILIKE $${paramIndex} OR 
                    LOWER(w.performer) ILIKE $${paramIndex}
                )`);
                params.push(`%${termLower}%`);
                paramIndex++;
            }
            if (conditions.length > 0) {
                whereConditions.push(`(${conditions.join(' AND ')})`);
            }
        }
        
        if (whereConditions.length === 0) {
            return res.render('video-search', { 
                title: 'Video Search',
                searchTerm: searchTerm,
                sortBy: sortBy,
                videos: [],
                totalVideos: 0,
                currentPage: 1,
                totalPages: 0,
                perPage: perPage,
                showFavoritesOnly: showFavoritesOnly
            });
        }
        
        // ⭐ Get favorite URLs from the database
        let favoriteUrls = [];
        if (showFavoritesOnly) {
            const favResult = await queryNeon('SELECT scene_url FROM video_favorites');
            favoriteUrls = favResult.map(row => row.scene_url);
            console.log(`⭐ Favorites only: ${favoriteUrls.length} favorited videos`);
        }
        
        // ⭐ Fetch ALL matching videos
        let query = `
            SELECT DISTINCT ON (w.video720p) 
                w.performer,
                w.title,
                w.duration,
                w.studio,
                w.url,
                w.video720p,
                w.video480p,
                w.date,
                w.performers,
                w.thumbnail
            FROM wow_videos w
            WHERE w.video720p IS NOT NULL 
              AND w.video720p != ''
              AND ${whereConditions.join(' AND ')}
            ORDER BY w.video720p
        `;
        
        let allVideos = await queryNeon(query, params);
        
        // ⭐ Filter by favorites if enabled
        if (showFavoritesOnly && favoriteUrls.length > 0) {
            const favSet = new Set(favoriteUrls);
            allVideos = allVideos.filter(video => favSet.has(video.url));
            console.log(`⭐ Filtered to ${allVideos.length} favorited videos`);
        }
        
        // Fix thumbnails and dates
        for (const video of allVideos) {
            if (!video.thumbnail || video.thumbnail.startsWith('data:image')) {
                let videoId = null;
                if (video.video720p) {
                    const match = video.video720p.match(/\/(\d+)_\d+[pm]\.mp4/);
                    if (match) videoId = match[1];
                }
                if (!videoId && video.video480p) {
                    const match = video.video480p.match(/\/(\d+)_\d+[pm]\.mp4/);
                    if (match) videoId = match[1];
                }
                if (videoId) {
                    const prefix = String(videoId).substring(0, 5);
                    video.thumbnail = `https://img.freesexvideos.xxx/${prefix}000/${videoId}/medium@2x/1.jpg`;
                }
            }
            
            if (video.date) {
                const parts = video.date.split('.');
                if (parts.length === 3) {
                    video.dateSort = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    video.displayDate = `${parts[1]}/${parts[0]}/${parts[2]}`;
                } else {
                    video.dateSort = '';
                    video.displayDate = video.date;
                }
            } else {
                video.dateSort = '';
            }
            
            if (video.performers) {
                video.performers = video.performers.replace(/\s*;\s*/g, '; ');
            }
        }
        
        // Sort in JavaScript
        if (sortBy === 'date') {
            allVideos.sort((a, b) => {
                const dateA = a.dateSort || '';
                const dateB = b.dateSort || '';
                if (!dateA && !dateB) return 0;
                if (!dateA) return 1;
                if (!dateB) return -1;
                return dateB.localeCompare(dateA);
            });
        } else if (sortBy === 'title') {
            allVideos.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        } else if (sortBy === 'duration') {
            allVideos.sort((a, b) => {
                const durA = a.duration ? parseDuration(a.duration) : 0;
                const durB = b.duration ? parseDuration(b.duration) : 0;
                return durB - durA;
            });
        }
        
        // Paginate
        const totalVideos = allVideos.length;
        const totalPages = Math.ceil(totalVideos / perPage);
        const startIndex = (page - 1) * perPage;
        const endIndex = Math.min(startIndex + perPage, totalVideos);
        const paginatedVideos = allVideos.slice(startIndex, endIndex);
        
        res.render('video-search', { 
            title: 'Video Search',
            searchTerm: searchTerm,
            sortBy: sortBy,
            videos: paginatedVideos,
            totalVideos: totalVideos,
            currentPage: page,
            totalPages: totalPages,
            perPage: perPage,
            showFavoritesOnly: showFavoritesOnly
        });
        
    } catch (error) {
        console.error('❌ Video search error:', error.message);
        console.error('   Stack:', error.stack);
        res.render('video-search', { 
            title: 'Video Search',
            searchTerm: searchTerm,
            sortBy: sortBy,
            videos: [],
            totalVideos: 0,
            currentPage: 1,
            totalPages: 0,
            perPage: perPage,
            showFavoritesOnly: showFavoritesOnly,
            error: error.message
        });
    }
});



// =========================
// VIDEO FAVORITES API ENDPOINTS
// =========================

// Get all favorited videos
app.get('/api/video-favorites', async (req, res) => {
    try {
        const result = await queryNeon(
            'SELECT * FROM video_favorites ORDER BY created_at DESC'
        );
        res.json({ success: true, favorites: result });
    } catch (error) {
        console.error('❌ Get video favorites error:', error.message);
        res.json({ success: false, error: error.message, favorites: [] });
    }
});

// Toggle favorite (add or remove)
app.post('/api/video-favorites/toggle', async (req, res) => {
    const { scene_url, title, thumbnail, video720p, video480p, studio, performers, duration, date } = req.body;
    
    if (!scene_url) {
        return res.json({ success: false, error: 'Scene URL is required' });
    }
    
    try {
        // Check if already favorited
        const existing = await queryNeon(
            'SELECT * FROM video_favorites WHERE scene_url = $1',
            [scene_url]
        );
        
        if (existing.length > 0) {
            // Remove from favorites
            await queryNeon(
                'DELETE FROM video_favorites WHERE scene_url = $1',
                [scene_url]
            );
            res.json({ success: true, favorited: false, message: 'Removed from favorites' });
        } else {
            // Add to favorites
            await queryNeon(
                `INSERT INTO video_favorites (scene_url, title, thumbnail, video720p, video480p, studio, performers, duration, date) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [scene_url, title, thumbnail, video720p, video480p, studio, performers, duration, date]
            );
            res.json({ success: true, favorited: true, message: 'Added to favorites' });
        }
    } catch (error) {
        console.error('❌ Toggle video favorite error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// Check if a scene is favorited
app.get('/api/video-favorites/check', async (req, res) => {
    const { scene_url } = req.query;
    
    if (!scene_url) {
        return res.json({ success: false, isFavorited: false });
    }
    
    try {
        const result = await queryNeon(
            'SELECT * FROM video_favorites WHERE scene_url = $1',
            [scene_url]
        );
        res.json({ success: true, isFavorited: result.length > 0 });
    } catch (error) {
        console.error('❌ Check video favorite error:', error.message);
        res.json({ success: false, isFavorited: false });
    }
});

// Get favorite scene URLs (for filtering)
app.get('/api/video-favorites/urls', async (req, res) => {
    try {
        const result = await queryNeon(
            'SELECT scene_url FROM video_favorites'
        );
        const urls = result.map(row => row.scene_url);
        res.json({ success: true, urls: urls });
    } catch (error) {
        console.error('❌ Get favorite URLs error:', error.message);
        res.json({ success: false, urls: [] });
    }
});



const axios = require('axios');
const cheerio = require('cheerio');

app.get('/api/download-proxy', async (req, res) => {
    const { sceneUrl, filename } = req.query;
    
    if (!sceneUrl || !sceneUrl.includes('/videos/')) {
        return res.status(400).json({ error: 'Invalid scene URL' });
    }
    
    try {
        console.log('📄 Fetching scene:', sceneUrl);
        
        // Fetch the scene HTML
        const sceneResponse = await axios.get(sceneUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.wow.xxx/'
            }
        });
        
        // Extract video URL
        const $ = cheerio.load(sceneResponse.data);
        let videoUrl = null;
        
        $('video source').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.includes('get_file')) {
                videoUrl = src;
                return false;
            }
        });
        
        if (!videoUrl) {
            return res.status(404).json({ error: 'Video URL not found' });
        }
        
        console.log('✅ Found video URL:', videoUrl.substring(0, 100) + '...');
        
        // Build the download URL
        const downloadUrl = videoUrl + 
            (videoUrl.includes('?') ? '&' : '?') + 
            `download=true&download_filename=${encodeURIComponent(filename || 'video.mp4')}`;
        
        // Fetch the video from wow.xxx
        const videoResponse = await axios({
            method: 'get',
            url: downloadUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.wow.xxx/',
                'Accept': 'video/mp4'
            },
            responseType: 'stream',
            timeout: 300000
        });
        
        // ===== FIX: Remove Content-Disposition for Spotify browser =====
        // This tells the browser to play the video, not download it
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', videoResponse.headers['content-length'] || '');
        // Don't set Content-Disposition for Spotify - this causes the play button with slash
        // res.setHeader('Content-Disposition', `attachment; filename="${filename || 'video.mp4'}"`);
        
        // Instead, set a header that allows inline playback
        res.setHeader('Content-Disposition', 'inline');
        
        console.log('✅ Streaming video (inline) for playback');
        
        // Stream the video
        videoResponse.data.pipe(res);
        
    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
        }
        res.status(500).json({ error: 'Failed to download: ' + error.message });
    }
});

// =========================
// START SERVER
// =========================
async function startServer() {
    console.log('🚀 Server starting...');
    app.listen(PORT, () => {
        console.log(`🚀 Server running at http://localhost:${PORT}`);
        console.log(`💾 Data source: Neon (on-demand queries) + Miget (ratings)`);
        console.log(`📊 Advanced Search: http://localhost:${PORT}/advanced-search`);
        console.log(`🎬 Video Mode: http://localhost:${PORT}/performer/{id}/videos`);
    });
}

startServer();

process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    if (migetDb) migetDb.end();
    if (neonDb) neonDb.end();
    process.exit(0);
});