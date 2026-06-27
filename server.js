const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const scraper = require('./scraper');
const app = express();
const PORT = process.env.PORT || 3000;

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
// CREATE DATABASE CONNECTION - SIMPLE SSL
// =========================
let db;

try {
    // Parse URL for debugging
    const url = new URL(process.env.DATABASE_URL);
    console.log('🔍 Host:', url.hostname);
    console.log('🔍 Port:', url.port);
    console.log('🔍 Database:', url.pathname.substring(1));

    db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false,  // Accept self-signed certificates
        },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
    });
    console.log('✅ PostgreSQL connection pool created (SSL verification disabled)');
} catch (error) {
    console.error('❌ Error creating PostgreSQL connection pool:', error.message);
    process.exit(1);
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
        console.error('❌ Full error details:', error);
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
// TEST ROUTE
// =========================
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await query('SELECT NOW() as current_time');
        res.json({ 
            success: true, 
            message: 'Database connected!',
            time: result.rows[0].current_time,
            database: 'PostgreSQL (Aiven)'
        });
    } catch (error) {
        console.error('❌ Database test failed:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            database: 'PostgreSQL (Aiven)'
        });
    }
});

// =========================
// API ROUTES
// =========================

app.post('/api/rate/performer', async (req, res) => {
    const { performerId, rating } = req.body;
    console.log(`🔍 Rating performer ${performerId} as ${rating}`);
    try {
        await query(
            `INSERT INTO performer_ratings (performer_id, rating, updated_at) 
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (performer_id) DO UPDATE SET rating = $2, updated_at = CURRENT_TIMESTAMP`,
            [performerId, rating]
        );
        console.log(`✅ Rating saved for ${performerId}`);
        res.json({ success: true, rating });
    } catch (error) {
        console.error('❌ Error saving performer rating:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/favorite/performer', async (req, res) => {
    const { performerId } = req.body;
    console.log(`🔍 Toggling favorite performer ${performerId}`);
    try {
        const result = await query(
            'SELECT performer_id FROM favorite_performers WHERE performer_id = $1',
            [performerId]
        );
        
        if (result.rows.length > 0) {
            await query('DELETE FROM favorite_performers WHERE performer_id = $1', [performerId]);
            console.log(`✅ Removed favorite for ${performerId}`);
            res.json({ success: true, favorited: false });
        } else {
            await query('INSERT INTO favorite_performers (performer_id) VALUES ($1)', [performerId]);
            console.log(`✅ Added favorite for ${performerId}`);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        console.error('❌ Error toggling performer favorite:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/favorite/scene', async (req, res) => {
    const { sceneId } = req.body;
    console.log(`🔍 Toggling favorite scene ${sceneId}`);
    try {
        const result = await query(
            'SELECT scene_id FROM favorite_scenes WHERE scene_id = $1',
            [sceneId]
        );
        
        if (result.rows.length > 0) {
            await query('DELETE FROM favorite_scenes WHERE scene_id = $1', [sceneId]);
            console.log(`✅ Removed favorite for scene ${sceneId}`);
            res.json({ success: true, favorited: false });
        } else {
            await query('INSERT INTO favorite_scenes (scene_id) VALUES ($1)', [sceneId]);
            console.log(`✅ Added favorite for scene ${sceneId}`);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        console.error('❌ Error toggling scene favorite:', error.message);
        res.status(500).json({ success: false, error: error.message });
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
        console.log(`🔍 Searching for: ${searchTerm}`);
        const performer = await scraper.findPerformer(searchTerm.trim());

        if (!performer) {
            return res.render('index', {
                title: 'Performer Viewer',
                performers: [],
                searchTerm,
                error: 'No performers found'
            });
        }

        const details = await scraper.getPerformerDetails(performer.id);
        const performers = [{ ...performer, ...details }];

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

app.get('/performer/:id', async (req, res) => {
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

app.get('/scene/:id', async (req, res) => {
    const sceneId = req.params.id;
    const userData = await getUserData();

    try {
        console.log(`🔍 Loading scene: ${sceneId}`);
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
    console.log(`💾 Using PostgreSQL (Aiven) - NO SQLITE FALLBACK`);
});

// =========================
// GRACEFUL SHUTDOWN
// =========================
process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    if (db) db.end();
    process.exit(0);
});