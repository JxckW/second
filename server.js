const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const scraper = require('./scraper');
const app = express();
const PORT = 3000;

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', './views');

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// SQLITE DATABASE SETUP
// =========================

const DB_FILE = path.join(__dirname, 'user_data.db');
const db = new sqlite3.Database(DB_FILE);

// Create tables if they don't exist
db.serialize(() => {
    // Performer ratings table
    db.run(`
        CREATE TABLE IF NOT EXISTS performer_ratings (
            performer_id TEXT PRIMARY KEY,
            rating TEXT CHECK(rating IN ('S', 'A', 'B', 'C', 'D', 'F', 'U', 'L')),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Favorite performers table
    db.run(`
        CREATE TABLE IF NOT EXISTS favorite_performers (
            performer_id TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Favorite scenes table
    db.run(`
        CREATE TABLE IF NOT EXISTS favorite_scenes (
            scene_id TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// =========================
// DATABASE HELPER FUNCTIONS
// =========================

// Promise wrapper for db operations
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// =========================
// API ROUTES - Using SQLite
// =========================

// Rate a performer
app.post('/api/rate/performer', async (req, res) => {
    const { performerId, rating } = req.body;
    try {
        await dbRun(
            `INSERT OR REPLACE INTO performer_ratings (performer_id, rating, updated_at) 
             VALUES (?, ?, CURRENT_TIMESTAMP)`,
            [performerId, rating]
        );
        res.json({ success: true, rating });
    } catch (error) {
        console.error('Error saving performer rating:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get performer rating
app.get('/api/rate/performer/:id', async (req, res) => {
    try {
        const row = await dbGet(
            `SELECT rating FROM performer_ratings WHERE performer_id = ?`,
            [req.params.id]
        );
        res.json({ rating: row ? row.rating : null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Toggle favorite performer
app.post('/api/favorite/performer', async (req, res) => {
    const { performerId } = req.body;
    try {
        // Check if already favorited
        const existing = await dbGet(
            `SELECT performer_id FROM favorite_performers WHERE performer_id = ?`,
            [performerId]
        );
        
        if (existing) {
            await dbRun(`DELETE FROM favorite_performers WHERE performer_id = ?`, [performerId]);
            res.json({ success: true, favorited: false });
        } else {
            await dbRun(`INSERT INTO favorite_performers (performer_id) VALUES (?)`, [performerId]);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        console.error('Error toggling performer favorite:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Toggle favorite scene
app.post('/api/favorite/scene', async (req, res) => {
    const { sceneId } = req.body;
    try {
        const existing = await dbGet(
            `SELECT scene_id FROM favorite_scenes WHERE scene_id = ?`,
            [sceneId]
        );
        
        if (existing) {
            await dbRun(`DELETE FROM favorite_scenes WHERE scene_id = ?`, [sceneId]);
            res.json({ success: true, favorited: false });
        } else {
            await dbRun(`INSERT INTO favorite_scenes (scene_id) VALUES (?)`, [sceneId]);
            res.json({ success: true, favorited: true });
        }
    } catch (error) {
        console.error('Error toggling scene favorite:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all user data
app.get('/api/user-data', async (req, res) => {
    try {
        const ratings = await dbAll(`SELECT performer_id, rating FROM performer_ratings`);
        const favPerformers = await dbAll(`SELECT performer_id FROM favorite_performers`);
        const favScenes = await dbAll(`SELECT scene_id FROM favorite_scenes`);
        
        res.json({
            performerRatings: ratings.reduce((acc, row) => {
                acc[row.performer_id] = row.rating;
                return acc;
            }, {}),
            favoritePerformers: favPerformers.map(row => row.performer_id),
            favoriteScenes: favScenes.map(row => row.scene_id)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =========================
// HELPER: Get user data for EJS templates
// =========================

async function getUserData() {
    try {
        const ratings = await dbAll(`SELECT performer_id, rating FROM performer_ratings`);
        const favPerformers = await dbAll(`SELECT performer_id FROM favorite_performers`);
        const favScenes = await dbAll(`SELECT scene_id FROM favorite_scenes`);
        
        return {
            performerRatings: ratings.reduce((acc, row) => {
                acc[row.performer_id] = row.rating;
                return acc;
            }, {}),
            favoritePerformers: favPerformers.map(row => row.performer_id),
            favoriteScenes: favScenes.map(row => row.scene_id)
        };
    } catch (error) {
        console.error('Error getting user data:', error);
        return {
            performerRatings: {},
            favoritePerformers: [],
            favoriteScenes: []
        };
    }
}

// =========================
// ROUTES
// =========================

app.get('/', async (req, res) => {
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
        console.error('Search error:', error);
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
        console.error('Performer error:', error);
        res.status(404).send(`Performer not found: ${error.message}`);
    }
});

app.get('/scene/:id', async (req, res) => {
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
        console.error('Scene error:', error);
        res.status(404).send(`Scene not found: ${error.message}`);
    }
});

// Close database on server shutdown
process.on('SIGINT', () => {
    db.close(() => {
        console.log('Database closed');
        process.exit(0);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`💾 SQLite database: ${DB_FILE}`);
});