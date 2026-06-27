const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const scraper = require('./scraper');

// =========================
// AUTHENTICATION MODULE
// =========================
const auth = require('./auth');

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
                console.log(`✅ Set ${key.trim()} = ${cleanValue.substring(0, 30)}...`);
            }
        }
    });
} else {
    console.log('❌ .env file NOT found at:', envPath);
}

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// VIEW ENGINE SETUP
// =========================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// =========================
// MIDDLEWARE - MUST COME BEFORE AUTH ROUTES
// =========================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// SETUP SESSION (from auth module)
// =========================
auth.setupSession(app);

// =========================
// SETUP LOGIN ROUTES (from auth module)
// =========================
auth.setupAuthRoutes(app);

// =========================
// DEBUGGING
// =========================
console.log('🔍 === DEBUGGING START ===');
console.log('🔍 DATABASE_URL exists?', !!process.env.DATABASE_URL);
if (process.env.DATABASE_URL) {
    const shortUrl = process.env.DATABASE_URL.substring(0, 30) + '...';
    console.log('🔍 DATABASE_URL (truncated):', shortUrl);
} else {
    console.log('❌ DATABASE_URL is NOT SET!');
}
console.log('🔍 NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('🔍 PORT:', PORT);
console.log('🔍 === DEBUGGING END ===');

if (!process.env.DATABASE_URL) {
    console.error('❌ FATAL ERROR: DATABASE_URL environment variable is required!');
    process.exit(1);
}

// =========================
// CREATE DATABASE CONNECTION
// =========================
let db;

try {
    const url = new URL(process.env.DATABASE_URL);
    console.log('🔍 Host:', url.hostname);
    console.log('🔍 Port:', url.port);
    console.log('🔍 Database:', url.pathname.substring(1));

    db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
    });
    console.log('✅ PostgreSQL connection pool created');
} catch (error) {
    console.error('❌ Error creating PostgreSQL connection pool:', error.message);
    process.exit(1);
}

// =========================
// DATABASE INITIALIZATION
// =========================

async function initDatabase() {
    console.log('🔍 Initializing database tables...');
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS performer_ratings (
                performer_id TEXT PRIMARY KEY,
                rating TEXT CHECK(rating IN ('S', 'A', 'B', 'C', 'D', 'F', 'U', 'L')),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ performer_ratings table ready');

        await db.query(`
            CREATE TABLE IF NOT EXISTS favorite_performers (
                performer_id TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ favorite_performers table ready');

        await db.query(`
            CREATE TABLE IF NOT EXISTS favorite_scenes (
                scene_id TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ favorite_scenes table ready');

        console.log('✅ All database tables initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error.message);
    }
}

initDatabase();

// =========================
// DATABASE HELPER FUNCTIONS
// =========================

async function query(sql, params = []) {
    try {
        const result = await db.query(sql, params);
        return result;
    } catch (error) {
        console.error('❌ Database query error:', error.message);
        throw error;
    }
}

async function getUserData() {
    try {
        const ratings = await query('SELECT performer_id, rating FROM performer_ratings');
        const favPerformers = await query('SELECT performer_id FROM favorite_performers');
        const favScenes = await query('SELECT scene_id FROM favorite_scenes');
        
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
// API ROUTES (Protected)
// =========================

app.post('/api/rate/performer', auth.requireAuth, async (req, res) => {
    const { performerId, rating } = req.body;
    try {
        await query(
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

app.post('/api/favorite/performer', auth.requireAuth, async (req, res) => {
    const { performerId } = req.body;
    try {
        const result = await query(
            'SELECT performer_id FROM favorite_performers WHERE performer_id = $1',
            [performerId]
        );
        if (result.rows.length > 0) {
            await query('DELETE FROM favorite_performers WHERE performer_id = $1', [performerId]);
            res.json({ success: true, favorited: false });
        } else {
            await query('INSERT INTO favorite_performers (performer_id) VALUES ($1)', [performerId]);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/favorite/scene', auth.requireAuth, async (req, res) => {
    const { sceneId } = req.body;
    try {
        const result = await query(
            'SELECT scene_id FROM favorite_scenes WHERE scene_id = $1',
            [sceneId]
        );
        if (result.rows.length > 0) {
            await query('DELETE FROM favorite_scenes WHERE scene_id = $1', [sceneId]);
            res.json({ success: true, favorited: false });
        } else {
            await query('INSERT INTO favorite_scenes (scene_id) VALUES ($1)', [sceneId]);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================
// SEARCH SCENES API (Protected)
// =========================
app.get('/api/performer/:id/scenes', auth.requireAuth, async (req, res) => {
    const performerId = req.params.id;
    const searchTerm = req.query.q || '';
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;

    try {
        const userData = await getUserData();
        const result = await scraper.searchPerformerScenes(performerId, searchTerm, page, perPage);
        
        const scenesWithUserData = result.scenes.map(scene => ({
            ...scene,
            isFavorited: userData.favoriteScenes.includes(scene.id)
        }));

        res.json({
            success: true,
            scenes: scenesWithUserData,
            totalCount: result.count,
            currentPage: page,
            totalPages: Math.ceil(result.count / perPage)
        });

    } catch (error) {
        console.error('❌ Scene search error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================
// SEARCH STUDIOS API (Protected)
// =========================
app.get('/api/search/studios', auth.requireAuth, async (req, res) => {
    const query = req.query.q || '';
    
    if (!query || query.length < 2) {
        return res.json({ studios: [] });
    }
    
    try {
        const gqlQuery = `
        query SearchStudios($term: String!) {
            searchStudio(term: $term) {
                id
                name
                images {
                    url
                }
            }
        }`;
        const data = await scraper.gql(gqlQuery, { term: query });
        res.json({ studios: data.searchStudio || [] });
    } catch (error) {
        console.error('❌ Studio search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// =========================
// WEB ROUTES (Protected)
// =========================

// Homepage
app.get('/', auth.requireAuth, (req, res) => {
    res.render('index', {
        title: 'Performer Viewer',
        performers: [],
        searchTerm: '',
        error: null
    });
});

// =========================
// SEARCH PERFORMER - POST ROUTE (Protected)
// =========================
app.post('/search', auth.requireAuth, async (req, res) => {
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
        console.log(`🔍 Searching for: ${searchTerm}`);
        const searchResults = await scraper.searchPerformers(searchTerm.trim());
        
        if (!searchResults || searchResults.length === 0) {
            return res.render('index', {
                title: 'Performer Viewer',
                performers: [],
                searchTerm,
                error: 'No performers found'
            });
        }

        const performers = [];
        const limit = Math.min(searchResults.length, 20);
        
        for (let i = 0; i < limit; i++) {
            const result = searchResults[i];
            try {
                const details = await scraper.getPerformerDetails(result.id);
                performers.push({ ...result, ...details });
            } catch (err) {
                console.error(`Error fetching details for ${result.name}:`, err.message);
                performers.push(result);
            }
        }

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
// PERFORMER PROFILE (Protected)
// =========================
app.get('/performer/:id', auth.requireAuth, async (req, res) => {
    const performerId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const userData = await getUserData();

    try {
        console.log(`🔍 Loading performer: ${performerId}`);
        const performer = await scraper.getPerformerDetails(performerId);
        const scenesData = await scraper.getScenes(performerId, page, perPage);

        const totalPages = Math.ceil(scenesData.count / perPage);

        const scenesWithUserData = scenesData.scenes.map(scene => ({
            ...scene,
            isFavorited: userData.favoriteScenes.includes(scene.id)
        }));

        res.render('performer', {
            title: performer.name,
            performer: performer,
            scenes: scenesWithUserData,
            currentPage: page,
            totalPages: totalPages,
            totalScenes: scenesData.count,
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
// STUDIO DETAILS PAGE (Protected)
// =========================
app.get('/studio/:id', auth.requireAuth, async (req, res) => {
    const studioId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    
    try {
        const userData = await getUserData();
        
        const studioQuery = `
        query StudioDetails($id: ID!) {
            findStudio(id: $id) {
                id
                name
                images {
                    url
                }
                is_favorite
            }
        }`;
        const studioData = await scraper.gql(studioQuery, { id: studioId });
        const studio = studioData.findStudio;
        
        if (!studio) {
            return res.status(404).send('Studio not found');
        }
        
        // Fetch all scenes for this studio
        const scenesQuery = `
        query StudioScenes($input: SceneQueryInput!) {
            queryScenes(input: $input) {
                count
                scenes {
                    id
                    title
                    date
                    duration
                    details
                    director
                    studio {
                        id
                        name
                    }
                    images {
                        url
                    }
                    performers {
                        performer {
                            id
                            name
                        }
                    }
                    tags {
                        id
                        name
                    }
                }
            }
        }`;

        let allScenes = [];
        let currentPage = 1;
        const perPageFetch = 100;
        let hasMore = true;

        while (hasMore) {
            const scenesData = await scraper.gql(scenesQuery, {
                input: {
                    studios: {
                        value: studioId,
                        modifier: "INCLUDES"
                    },
                    page: currentPage,
                    per_page: perPageFetch,
                    sort: 'DATE',
                    direction: 'DESC'
                }
            });

            const scenes = scenesData.queryScenes.scenes || [];
            allScenes = allScenes.concat(scenes);

            const totalCount = scenesData.queryScenes.count || 0;
            hasMore = allScenes.length < totalCount;
            currentPage++;

            if (allScenes.length >= 1000 || currentPage > 20) {
                hasMore = false;
            }
        }

        console.log(`📊 Fetched ${allScenes.length} total scenes for studio: ${studio.name}`);

        const scenesWithRatings = allScenes.map(scene => {
            const performerRatings = scene.performers?.map(p => {
                const pid = p.performer.id;
                return userData.performerRatings[pid] || null;
            }).filter(r => r !== null) || [];
            
            const tier = performerRatings.length > 0 ? performerRatings.sort()[0] : null;
            
            return {
                ...scene,
                performerRating: tier,
                isFavorited: userData.favoriteScenes.includes(scene.id)
            };
        });

        const performersSet = new Set();
        allScenes.forEach(scene => {
            scene.performers?.forEach(p => {
                performersSet.add(p.performer.id);
            });
        });

        const totalScenes = scenesWithRatings.length;
        const startIndex = (page - 1) * perPage;
        const endIndex = Math.min(startIndex + perPage, totalScenes);
        const paginatedScenes = scenesWithRatings.slice(startIndex, endIndex);
        
        const totalPages = Math.ceil(totalScenes / perPage);
        const studioImage = studio.images && studio.images.length > 0 ? studio.images[0].url : null;
        
        res.render('studio', {
            title: studio.name,
            studioName: studio.name,
            studioId: studio.id,
            studioImage: studioImage,
            totalScenes: totalScenes,
            performersCount: performersSet.size,
            scenes: paginatedScenes,
            allScenes: scenesWithRatings,
            currentPage: page,
            totalPages: totalPages,
            studioId: studioId,
            isFavorite: studio.is_favorite
        });
        
    } catch (error) {
        console.error('❌ Studio error:', error.message);
        res.status(404).send(`Studio not found: ${error.message}`);
    }
});

// =========================
// SCENE DETAILS (Protected)
// =========================
app.get('/scene/:id', auth.requireAuth, async (req, res) => {
    const sceneId = req.params.id;
    const userData = await getUserData();

    try {
        const query = `
        query SceneDetails($id: ID!) {
            findScene(id: $id) {
                id
                title
                date
                duration
                details
                director
                studio {
                    id
                    name
                }
                images {
                    url
                }
                performers {
                    performer {
                        id
                        name
                    }
                }
                tags {
                    id
                    name
                }
            }
        }`;

        const data = await scraper.gql(query, { id: sceneId });
        const scene = data.findScene;

        if (!scene) {
            return res.status(404).send('Scene not found');
        }

        res.render('scene', {
            title: scene.title || 'Scene',
            scene: scene,
            isFavorited: userData.favoriteScenes.includes(sceneId)
        });

    } catch (error) {
        console.error('❌ Scene error:', error.message);
        res.status(404).send(`Scene not found: ${error.message}`);
    }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`💾 Using PostgreSQL (Miget) - NO SQLITE FALLBACK`);
    console.log(`🔒 Password protection enabled`);
});

process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    if (db) db.end();
    process.exit(0);
});