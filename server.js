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

// 1. Miget PostgreSQL (for ratings/favorites - existing)
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
    console.log('✅ Miget PostgreSQL connection pool created (for ratings/favorites)');
} catch (error) {
    console.error('❌ Error creating Miget PostgreSQL connection pool:', error.message);
    process.exit(1);
}

// 2. Neon PostgreSQL (for performer data - QUERIED ON DEMAND)
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
        console.log('✅ Neon PostgreSQL connection pool created (for performer data - on-demand queries)');
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
// NEON QUERY FUNCTIONS (ON DEMAND)
// =========================

// Get single performer by ID
async function getPerformerById(id) {
    const result = await queryNeon('SELECT * FROM performers WHERE id = $1', [id]);
    if (result.length === 0) return null;
    return result[0];
}

// Get scenes for a performer with pagination
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

// Search performers
async function searchPerformers(term) {
    return await queryNeon(
        "SELECT * FROM performers WHERE name ILIKE $1 OR aliases ILIKE $1 LIMIT 20",
        [`%${term}%`]
    );
}

// Get studio by ID
async function getStudio(id) {
    const result = await queryNeon('SELECT * FROM studios WHERE id = $1', [id]);
    return result.length > 0 ? result[0] : null;
}

// Get scenes for a studio
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

// Get wow videos for performer
async function getWowVideos(performerName) {
    const result = await queryNeon(
        "SELECT * FROM wow_videos WHERE performer_name = $1",
        [performerName]
    );
    return result;
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
        const result = await queryMiget(
            'SELECT performer_id FROM favorite_performers WHERE performer_id = $1',
            [performerId]
        );
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
        const result = await queryMiget(
            'SELECT scene_id FROM favorite_scenes WHERE scene_id = $1',
            [sceneId]
        );
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
// SEARCH STUDIOS API - SHOW ALL STUDIOS
// =========================
app.get('/api/search/studios', async (req, res) => {
    const query = req.query.q || '';
    
    try {
        console.time('⏱️ Studio search time');
        
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
        console.timeEnd('⏱️ Studio search time');
        console.log(`📊 Found ${studios.length} studios`);
        
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

// =========================
// SEARCH PERFORMER
// =========================
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
// ADVANCED SEARCH API - FIXED FOR ALL MATCH TYPES
// =========================
app.get('/api/search/advanced', async (req, res) => {
    const { studios = '', tier = '', favorite = '', match = 'any', page = 1, perPage = 50 } = req.query;
    const userData = await getUserData();
    const studioNames = studios ? studios.split(',').map(s => s.trim()) : [];
    const offset = (parseInt(page) - 1) * parseInt(perPage);
    
    if (studioNames.length === 0) {
        return res.json({ success: true, performers: [], total: 0, page: 1, totalPages: 0 });
    }
    
    try {
        console.log(`🔍 Searching for studios: ${studioNames.join(', ')}`);
        console.log(`📄 Match type: ${match}`);
        console.time('⏱️ Advanced search total time');
        
        let params = [];
        let paramIndex = 1;
        
        const studioConditions = studioNames.map(name => {
            return `LOWER(s.studio_name) = LOWER($${paramIndex++})`;
        });
        studioNames.forEach(name => params.push(name));
        
        let performerQuery = '';
        let queryParams = [...params];
        
        if (match === 'any') {
            performerQuery = `
                SELECT 
                    p.id,
                    p.name,
                    p.gender,
                    p.age,
                    p.height,
                    p.scene_count,
                    p.country,
                    p.ethnicity,
                    p.aliases,
                    p.is_favorite,
                    p.images,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                WHERE ${studioConditions.join(' OR ')}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, p.ethnicity, p.aliases, p.is_favorite, p.images
            `;
        } else if (match === 'all') {
            performerQuery = `
                SELECT 
                    p.id,
                    p.name,
                    p.gender,
                    p.age,
                    p.height,
                    p.scene_count,
                    p.country,
                    p.ethnicity,
                    p.aliases,
                    p.is_favorite,
                    p.images,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                WHERE s.studio_name IS NOT NULL AND s.studio_name != ''
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, p.ethnicity, p.aliases, p.is_favorite, p.images
                HAVING 
                    COUNT(DISTINCT CASE WHEN ${studioConditions.join(' OR ')} THEN s.studio_name END) = ${studioNames.length}
                    AND COUNT(DISTINCT s.studio_name) >= ${studioNames.length}
            `;
        } else if (match === 'exact') {
            performerQuery = `
                SELECT 
                    p.id,
                    p.name,
                    p.gender,
                    p.age,
                    p.height,
                    p.scene_count,
                    p.country,
                    p.ethnicity,
                    p.aliases,
                    p.is_favorite,
                    p.images,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                WHERE s.studio_name IS NOT NULL AND s.studio_name != ''
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, p.ethnicity, p.aliases, p.is_favorite, p.images
                HAVING 
                    COUNT(DISTINCT CASE WHEN ${studioConditions.join(' OR ')} THEN s.studio_name END) = ${studioNames.length}
                    AND COUNT(DISTINCT s.studio_name) = ${studioNames.length}
            `;
        }
        
        console.time('⏱️ Main query');
        console.log('📝 Query type:', match);
        const matchedPerformers = await queryNeon(performerQuery, queryParams);
        console.timeEnd('⏱️ Main query');
        
        if (matchedPerformers.length === 0) {
            console.log('📊 No performers found matching criteria');
            return res.json({ 
                success: true, 
                performers: [], 
                total: 0, 
                page: parseInt(page), 
                totalPages: 0 
            });
        }
        
        console.log(`📊 Found ${matchedPerformers.length} performers matching studios`);
        
        const performerIdList = matchedPerformers.map(p => p.id);
        let filteredPerformers = matchedPerformers;
        
        if (tier && tier !== 'all') {
            const ids = performerIdList.map(id => `'${id}'`).join(',');
            
            if (tier === 'rated') {
                const ratedIds = await queryMiget(
                    `SELECT performer_id FROM performer_ratings WHERE performer_id IN (${ids})`
                );
                const ratedSet = new Set(ratedIds.rows.map(r => r.performer_id));
                filteredPerformers = filteredPerformers.filter(p => ratedSet.has(p.id));
            } else if (tier === 'unrated') {
                const ratedIds = await queryMiget(
                    `SELECT performer_id FROM performer_ratings WHERE performer_id IN (${ids})`
                );
                const ratedSet = new Set(ratedIds.rows.map(r => r.performer_id));
                filteredPerformers = filteredPerformers.filter(p => !ratedSet.has(p.id));
            } else {
                const ratedIds = await queryMiget(
                    `SELECT performer_id FROM performer_ratings WHERE performer_id IN (${ids}) AND rating = $1`,
                    [tier]
                );
                const ratedSet = new Set(ratedIds.rows.map(r => r.performer_id));
                filteredPerformers = filteredPerformers.filter(p => ratedSet.has(p.id));
            }
        }
        
        if (favorite === 'true') {
            const ids = filteredPerformers.map(p => `'${p.id}'`).join(',');
            const favIds = await queryMiget(
                `SELECT performer_id FROM favorite_performers WHERE performer_id IN (${ids})`
            );
            const favSet = new Set(favIds.rows.map(r => r.performer_id));
            filteredPerformers = filteredPerformers.filter(p => favSet.has(p.id));
        } else if (favorite === 'false') {
            const ids = filteredPerformers.map(p => `'${p.id}'`).join(',');
            const favIds = await queryMiget(
                `SELECT performer_id FROM favorite_performers WHERE performer_id IN (${ids})`
            );
            const favSet = new Set(favIds.rows.map(r => r.performer_id));
            filteredPerformers = filteredPerformers.filter(p => !favSet.has(p.id));
        }
        
        const total = filteredPerformers.length;
        console.log(`📊 After filters: ${total} performers`);
        
        if (total === 0) {
            return res.json({ 
                success: true, 
                performers: [], 
                total: 0, 
                page: parseInt(page), 
                totalPages: 0 
            });
        }
        
        const paginatedPerformers = filteredPerformers.slice(offset, offset + parseInt(perPage));
        
        const paginatedIds = paginatedPerformers.map(p => p.id);
        let performerRatings = {};
        let favoritePerformers = [];
        
        if (paginatedIds.length > 0) {
            const ids = paginatedIds.map(id => `'${id}'`).join(',');
            
            const ratingsResult = await queryMiget(
                `SELECT performer_id, rating FROM performer_ratings WHERE performer_id IN (${ids})`
            );
            ratingsResult.rows.forEach(row => {
                performerRatings[row.performer_id] = row.rating;
            });
            
            const favResult = await queryMiget(
                `SELECT performer_id FROM favorite_performers WHERE performer_id IN (${ids})`
            );
            favoritePerformers = favResult.rows.map(row => row.performer_id);
        }
        
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
                country: p.country || '',
                ethnicity: p.ethnicity || '',
                aliases: aliases,
                is_favorite: p.is_favorite === 'true' || p.is_favorite === true,
                images: images.slice(0, 1),
                rating: performerRatings[p.id] || null,
                is_favorited: favoritePerformers.includes(p.id),
                studio_count: parseInt(p.studio_count) || 0
            };
        });
        
        console.timeEnd('⏱️ Advanced search total time');
        
        res.json({
            success: true,
            performers: formattedResults,
            total: total,
            page: parseInt(page),
            perPage: parseInt(perPage),
            totalPages: Math.ceil(total / parseInt(perPage))
        });
        
    } catch (error) {
        console.error('❌ Advanced search error:', error.message);
        console.error('Stack:', error.stack);
        res.json({ success: false, error: error.message, performers: [] });
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
        
        const scenesWithRatings = scenes.map(scene => {
            return {
                ...scene,
                performerRating: null,
                isFavorited: userData.favoriteScenes.includes(scene.id)
            };
        });
        
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

// =========================
// ADVANCED SEARCH PAGE
// =========================
app.get('/advanced-search', (req, res) => {
    res.render('advanced-search', { title: 'Advanced Studio Search' });
});

// =========================
// VIDEO MODE ROUTES
// =========================

app.get('/api/performer/:id/wow-scenes', async (req, res) => {
    const performerId = req.params.id;
    
    try {
        const performer = await getPerformerById(performerId);
        if (!performer) {
            return res.json({ success: false, error: 'Performer not found' });
        }
        
        const performerName = performer.name;
        const wowVideos = await getWowVideos(performerName);
        
        const scenes = wowVideos.map(video => ({
            id: video.video_id || 'unknown',
            title: video.title || 'Untitled Scene',
            duration: video.duration || '0:00',
            date: null,
            studio: video.studio ? { name: video.studio } : null,
            images: video.thumbnail ? [{ url: video.thumbnail }] : [],
            video720p: video.video720p,
            isFavorited: false,
            performerName: performerName,
            wowUrl: video.url,
            allQualities: video.all_qualities ? JSON.parse(video.all_qualities) : []
        }));
        
        res.json({
            success: true,
            scenes: scenes,
            performerName: performerName,
            totalScenes: scenes.length,
            videosFound: scenes.filter(s => s.video720p).length
        });
        
    } catch (error) {
        console.error('❌ Error fetching wow scenes:', error.message);
        res.json({ success: false, error: error.message, scenes: [] });
    }
});

// In server.js - Add this endpoint
app.get('/api/video/proxy-stream', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }
    
    try {
        console.log('📡 Streaming video through Render proxy...');
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.wow.xxx/',
                'Accept': 'video/mp4, video/webm, video/*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        if (!response.ok && response.status !== 206) {
            return res.status(response.status).json({ error: `Failed: ${response.status}` });
        }
        
        res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Disposition', 'inline');
        
        // Stream the video in chunks
        const reader = response.body.getReader();
        const stream = new ReadableStream({
            start(controller) {
                function push() {
                    reader.read().then(({ done, value }) => {
                        if (done) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(value);
                        push();
                    }).catch(err => {
                        console.error('Stream error:', err);
                        controller.error(err);
                    });
                }
                push();
            }
        });
        stream.pipeTo(res);
        
    } catch (error) {
        console.error('❌ Stream error:', error.message);
        res.status(500).json({ error: error.message });
    }
});




// =========================
// VIDEO PROXY AND TOKEN FETCHING
// =========================

// Stream video through Render (helper function)
function streamVideoThroughRender(response, res) {
    console.log('📡 Streaming video through Render...');
    
    res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    if (response.status === 206) {
        const contentRange = response.headers.get('content-range');
        if (contentRange) {
            res.setHeader('Content-Range', contentRange);
        }
        res.status(206);
    }
    
    const length = response.headers.get('content-length');
    if (length) {
        res.setHeader('Content-Length', length);
    }
    
    const reader = response.body.getReader();
    const stream = new ReadableStream({
        start(controller) {
            function push() {
                reader.read().then(({ done, value }) => {
                    if (done) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(value);
                    push();
                }).catch(err => {
                    console.error('Stream error:', err);
                    controller.error(err);
                });
            }
            push();
        },
        cancel() {
            reader.cancel();
        }
    });
    
    stream.pipeTo(res);
}

// Extract slug from scene URL
function extractSlugFromUrl(sceneUrl) {
    const match = sceneUrl.match(/\/videos\/([^\/]+)\//);
    return match ? match[1] : null;
}

// =========================
// FETCH TOKEN ENDPOINT - Returns CDN URL
// =========================
app.get('/api/video/fetch-token', async (req, res) => {
    const { sceneUrl } = req.query;
    
    if (!sceneUrl) {
        return res.status(400).json({ error: 'No scene URL provided' });
    }
    
    try {
        const slug = sceneUrl.match(/\/videos\/([^\/]+)\//)?.[1];
        if (!slug) {
            return res.status(400).json({ error: 'Invalid scene URL' });
        }
        
        const pageUrl = `https://www.wow.xxx/videos/${slug}/`;
        console.log('📡 Server fetching token from:', pageUrl);
        
        const response = await fetch(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Referer': 'https://www.wow.xxx/',
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!response.ok) {
            return res.status(response.status).json({ error: `HTTP ${response.status}` });
        }
        
        const html = await response.text();
        
        let getFileUrl = null;
        const qualityPatterns = [
            /https:\/\/www\.wow\.xxx\/get_file\/[^\s"']*2160[^\s"']*/,
            /https:\/\/www\.wow\.xxx\/get_file\/[^\s"']*1080[^\s"']*/,
            /https:\/\/www\.wow\.xxx\/get_file\/[^\s"']*720[^\s"']*/,
            /https:\/\/www\.wow\.xxx\/get_file\/[^\s"']*480[^\s"']*/,
            /https:\/\/www\.wow\.xxx\/get_file\/[^\s"']+/
        ];
        
        for (const pattern of qualityPatterns) {
            const match = html.match(pattern);
            if (match) {
                getFileUrl = match[0];
                console.log('✅ Found get_file URL');
                break;
            }
        }
        
        if (!getFileUrl) {
            return res.status(404).json({ error: 'No video URL found in page' });
        }
        
        // Fetch the get_file URL to get the CDN redirect
        console.log('📡 Fetching get_file URL for CDN redirect...');
        const cdnResponse = await fetch(getFileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.wow.xxx/',
                'Origin': 'https://www.wow.xxx',
                'Accept': 'video/mp4, video/webm, video/*',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'manual'
        });
        
        let cdnUrl = null;
        if (cdnResponse.status === 301 || cdnResponse.status === 302 || cdnResponse.status === 303) {
            cdnUrl = cdnResponse.headers.get('location');
            console.log('✅ Got CDN redirect');
        } else if (cdnResponse.ok || cdnResponse.status === 206) {
            cdnUrl = getFileUrl;
            console.log('✅ Video served directly');
        } else {
            console.log('❌ CDN fetch failed:', cdnResponse.status);
            return res.status(cdnResponse.status).json({ 
                error: `CDN fetch failed: ${cdnResponse.status}`
            });
        }
        
        if (!cdnUrl) {
            return res.status(404).json({ error: 'No CDN URL found' });
        }
        
        const tokenMatch = getFileUrl.match(/get_file\/\d+\/([a-f0-9]+)\//);
        const token = tokenMatch ? tokenMatch[1] : null;
        
        console.log('✅ Returning CDN URL to client');
        
        res.json({
            success: true,
            token: token,
            cdnUrl: cdnUrl,
            videoUrl: cdnUrl
        });
        
    } catch (error) {
        console.error('❌ Error fetching token:', error.message);
        res.status(500).json({ error: error.message });
    }
});
// =========================
// VIDEO MODE PAGE
// =========================
app.get('/performer/:id/videos', async (req, res) => {
    const performerId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    
    try {
        const performer = await getPerformerById(performerId);
        if (!performer) {
            return res.status(404).send('Performer not found');
        }
        
        const performerName = performer.name;
        const wowVideos = await getWowVideos(performerName);
        
        const allScenes = wowVideos.map(video => ({
            id: video.video_id || 'unknown',
            title: video.title || 'Untitled Scene',
            duration: video.duration || '0:00',
            studio: video.studio ? { name: video.studio } : null,
            images: video.thumbnail ? [{ url: video.thumbnail }] : [],
            video720p: video.video720p,
            url: video.url,
            allQualities: video.all_qualities ? JSON.parse(video.all_qualities || '[]') : []
        }));
        
        const totalWowScenes = allScenes.length;
        const videosFound = allScenes.filter(s => s.video720p).length;
        const totalPages = Math.ceil(totalWowScenes / perPage);
        
        const startIndex = (page - 1) * perPage;
        const endIndex = Math.min(startIndex + perPage, totalWowScenes);
        const wowScenes = allScenes.slice(startIndex, endIndex);
        
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
            wowScenes: wowScenes,
            totalWowScenes: totalWowScenes,
            videosFound: videosFound,
            hasWowData: wowScenes.length > 0,
            currentPage: page,
            totalPages: totalPages,
            perPage: perPage
        });
        
    } catch (error) {
        console.error('❌ Video mode error:', error.message);
        res.status(500).send('Error loading videos');
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