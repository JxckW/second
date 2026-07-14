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
// ADVANCED SEARCH API - WITH CUPSIZE FILTER (FIXED)
// =========================
app.get('/api/search/advanced', async (req, res) => {
    const { 
        studios = '', 
        tier = '', 
        favorite = '', 
        match = 'any', 
        cupsize = '',
        page = 1, 
        perPage = 50 
    } = req.query;
    
    const userData = await getUserData();
    const studioNames = studios ? studios.split(',').map(s => s.trim()).filter(s => s) : [];
    const offset = (parseInt(page) - 1) * parseInt(perPage);
    const limit = parseInt(perPage);
    
    // If no studios, no cupsize, and no rating, return empty
    if (studioNames.length === 0 && !cupsize && !tier && !favorite) {
        return res.json({ success: true, performers: [], total: 0, page: 1, totalPages: 0 });
    }
    
    try {
        // =========================
        // BUILD THE QUERY WITH PROPER PARAMETER HANDLING
        // =========================
        let params = [];
        let paramIndex = 1;
        let whereConditions = [];
        let havingConditions = [];
        let havingParams = [];
        
        // Studio conditions
        if (studioNames.length > 0) {
            if (match === 'any') {
                // For 'any', we use WHERE with OR
                const studioConditions = studioNames.map(name => {
                    return `LOWER(s.studio_name) = LOWER($${paramIndex++})`;
                });
                studioNames.forEach(name => params.push(name));
                whereConditions.push(`(${studioConditions.join(' OR ')})`);
            } else {
                // For 'all' and 'exact', we need to include studio in HAVING
                whereConditions.push(`s.studio_name IS NOT NULL AND s.studio_name != ''`);
                
                // Build HAVING conditions with proper parameter references
                // We need to use different parameter indices for HAVING
                const havingStartIndex = paramIndex;
                studioNames.forEach((name, idx) => {
                    const pIdx = havingStartIndex + idx;
                    havingConditions.push(`COUNT(DISTINCT CASE WHEN LOWER(s.studio_name) = LOWER($${pIdx}) THEN s.studio_name END) = 1`);
                    havingParams.push(name);
                });
                // Update paramIndex after adding having params
                paramIndex += studioNames.length;
                // Add having params to the main params array
                params = params.concat(havingParams);
            }
        }
        
        // Cupsize condition
        if (cupsize) {
            const cupsizeValues = cupsize.split(',').map(c => c.trim().toUpperCase()).filter(c => c);
            if (cupsizeValues.length > 0) {
                const hasOther = cupsizeValues.includes('OTHER');
                const specificSizes = cupsizeValues.filter(c => c !== 'OTHER');
                
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
        }
        
        // Favorite filter (Neon)
        if (favorite === 'true') {
            whereConditions.push(`p.is_favorite = true`);
        } else if (favorite === 'false') {
            whereConditions.push(`(p.is_favorite = false OR p.is_favorite IS NULL)`);
        }
        
        // =========================
        // BUILD NEON QUERY
        // =========================
        let performerQuery = '';
        let queryParams = [...params];
        let hasStudioJoin = studioNames.length > 0;
        
        if (!hasStudioJoin) {
            // No studios - just performers
            performerQuery = `
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    0 as studio_count
                FROM performers p
                ${whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : ''}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize
            `;
        } else if (match === 'any') {
            performerQuery = `
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                ${whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : ''}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize
            `;
        } else if (match === 'all') {
            performerQuery = `
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                ${whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : ''}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize
                HAVING 
                    ${havingConditions.join(' AND ')}
                    AND COUNT(DISTINCT s.studio_name) >= ${studioNames.length}
            `;
        } else if (match === 'exact') {
            performerQuery = `
                SELECT 
                    p.id, p.name, p.gender, p.age, p.height, p.scene_count, p.country, 
                    p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize,
                    COUNT(DISTINCT s.studio_name) as studio_count
                FROM performers p
                JOIN performer_scenes ps ON p.id = ps.performer_id
                JOIN scenes s ON ps.scene_id = s.id
                ${whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : ''}
                GROUP BY p.id, p.name, p.gender, p.age, p.height, p.scene_count, 
                         p.country, p.ethnicity, p.aliases, p.is_favorite, p.images, p.cupsize
                HAVING 
                    ${havingConditions.join(' AND ')}
                    AND COUNT(DISTINCT s.studio_name) = ${studioNames.length}
            `;
        }
        
        // Execute Neon query (NO PAGINATION - get all results)
        const matchedPerformers = await queryNeon(performerQuery, queryParams);
        
        // =========================
        // STEP 2: Get ratings from Miget for these performers
        // =========================
        const performerIds = matchedPerformers.map(p => p.id);
        let performerRatings = {};
        let favoritePerformers = [];
        let filteredPerformers = matchedPerformers;
        
        if (performerIds.length > 0) {
            const ids = performerIds.map(id => `'${id}'`).join(',');
            
            // Get ratings from Miget
            const ratingsResult = await queryMiget(`SELECT performer_id, rating FROM performer_ratings WHERE performer_id IN (${ids})`);
            ratingsResult.rows.forEach(row => {
                performerRatings[row.performer_id] = row.rating;
            });
            
            // Get favorites from Miget
            const favResult = await queryMiget(`SELECT performer_id FROM favorite_performers WHERE performer_id IN (${ids})`);
            favoritePerformers = favResult.rows.map(row => row.performer_id);
            
            // =========================
            // STEP 3: Filter by rating (Miget) if tier is specified
            // =========================
            if (tier) {
                const ratingValue = tier.trim().toUpperCase();
                
                if (ratingValue === 'RATED') {
                    filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] !== undefined);
                } else if (ratingValue === 'UNRATED') {
                    filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] === undefined);
                } else if (['S', 'A', 'B', 'C', 'D', 'F', 'U', 'L'].includes(ratingValue)) {
                    filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] === ratingValue);
                } else {
                    const ratingNum = parseInt(ratingValue);
                    if (!isNaN(ratingNum) && ratingNum >= 1 && ratingNum <= 5) {
                        filteredPerformers = matchedPerformers.filter(p => performerRatings[p.id] === ratingNum);
                    }
                }
            }
            
            // =========================
            // STEP 4: Filter by favorite (Miget) if not already filtered
            // =========================
            if (favorite === 'true' && !favorite.includes('is_favorite')) {
                filteredPerformers = filteredPerformers.filter(p => favoritePerformers.includes(p.id));
            } else if (favorite === 'false' && !favorite.includes('is_favorite')) {
                filteredPerformers = filteredPerformers.filter(p => !favoritePerformers.includes(p.id));
            }
        }
        
        // =========================
        // STEP 5: Calculate total and paginate
        // =========================
        const total = filteredPerformers.length;
        const totalPages = Math.ceil(total / limit);
        
        // Paginate the filtered results
        const paginatedPerformers = filteredPerformers.slice(offset, offset + limit);
        
        // =========================
        // STEP 6: Format results
        // =========================
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
                cupsize: p.cupsize || null,
                is_favorite: p.is_favorite === 'true' || p.is_favorite === true,
                images: images.slice(0, 1),
                rating: performerRatings[p.id] || null,
                is_favorited: favoritePerformers.includes(p.id),
                studio_count: parseInt(p.studio_count) || 0
            };
        });
        
        res.json({
            success: true,
            performers: formattedResults,
            total: total,
            page: parseInt(page),
            perPage: limit,
            totalPages: totalPages
        });
        
    } catch (error) {
        console.error('❌ Advanced search error:', error.message);
        console.error('   Query params:', JSON.stringify(params));
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
// VIDEO MODE PAGE - NO DATES, DEDUPLICATED VIDEOS
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
        
        // Get ALL wow_videos for this performer - DEDUPLICATED by video_url
        const allWowVideos = await queryNeon(`
            SELECT DISTINCT ON (video_url) 
                video_url,
                performer_name,
                title,
                duration,
                studio,
                url,
                thumbnail
            FROM wow_videos
            WHERE performer_name ILIKE $1
              AND video_url IS NOT NULL 
              AND video_url != ''
            ORDER BY video_url, title
        `, [`%${performerName}%`]);
        
        console.log(`📊 Found ${allWowVideos.length} unique wow_videos for ${performerName}`);
        
        // Sort videos by title
        allWowVideos.sort((a, b) => {
            return (a.title || '').localeCompare(b.title || '');
        });
        
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
            perPage: perPage
        });
        
    } catch (error) {
        console.error('❌ Video mode error:', error.message);
        res.status(500).send('Error loading videos');
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

// =========================
// VIDEO URL ENDPOINT - DEDUPLICATED
// =========================
app.get('/api/video/url', async (req, res) => {
    const { sceneUrl } = req.query;
    
    if (!sceneUrl) {
        return res.status(400).json({ error: 'No scene URL provided' });
    }
    
    try {
        // Look up by url or title - get unique video_url
        let result = await queryNeon(
            `SELECT DISTINCT ON (video_url) video_url 
             FROM wow_videos 
             WHERE url = $1 OR title ILIKE $1
             ORDER BY video_url`,
            [sceneUrl]
        );
        
        if (result.length === 0) {
            result = await queryNeon(
                `SELECT DISTINCT ON (video_url) video_url 
                 FROM wow_videos 
                 WHERE scene_url = $1
                 ORDER BY video_url`,
                [sceneUrl]
            );
        }
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Video not found in database' });
        }
        
        res.json({ success: true, videoUrl: result[0].video_url });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
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