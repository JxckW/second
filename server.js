const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

// =========================
// AUTHENTICATION MODULE
// =========================
const auth = require('./auth');

// =========================
// DATA LOADER - Loads from URL or local cache
// =========================
const { fetchData, DATA_URLS } = require('./data-loader');

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
// DATA STORAGE (in-memory)
// =========================
let performerList = [];
let performerMap = {};
let studioMap = {};
let sceneMap = {};
let wowData = null;

// =========================
// LOAD STASHDB DATA
// =========================
async function loadStashData() {
    console.log('📂 Loading StashDB data...');
    
    const data = await fetchData(DATA_URLS.stashdb, 'stashdb_data.json');
    
    if (!data) {
        console.error('❌ Failed to load StashDB data');
        return;
    }
    
    // Parse the data
    let performerData = data;
    if (data.data && Array.isArray(data.data)) {
        performerData = data.data;
    } else if (data.performers && Array.isArray(data.performers)) {
        performerData = data.performers;
    }
    
    if (Array.isArray(performerData)) {
        performerData.forEach(item => {
            const performer = item.performer || item;
            if (performer && performer.id) {
                performerMap[performer.id] = item;
                
                performerList.push({
                    id: performer.id,
                    name: performer.name,
                    gender: performer.gender,
                    age: performer.age,
                    height: performer.height,
                    scene_count: (item.scenes && Array.isArray(item.scenes)) ? item.scenes.length : 0,
                    country: performer.country,
                    ethnicity: performer.ethnicity,
                    aliases: performer.aliases || [],
                    is_favorite: performer.is_favorite || false,
                    images: performer.images || []
                });
                
                if (item.scenes && Array.isArray(item.scenes)) {
                    item.scenes.forEach(scene => {
                        if (scene && scene.id) {
                            sceneMap[scene.id] = scene;
                            
                            if (scene.studio && scene.studio.id) {
                                const studioId = scene.studio.id;
                                const studioName = scene.studio.name || 'Unknown Studio';
                                
                                if (!studioMap[studioId]) {
                                    studioMap[studioId] = {
                                        id: studioId,
                                        name: studioName,
                                        scenes: []
                                    };
                                }
                                if (!studioMap[studioId].scenes.includes(scene.id)) {
                                    studioMap[studioId].scenes.push(scene.id);
                                }
                            }
                        }
                    });
                }
            }
        });
        
        console.log(`✅ Loaded ${performerList.length} performers`);
        console.log(`✅ ${Object.keys(sceneMap).length} scenes`);
        console.log(`✅ ${Object.keys(studioMap).length} studios`);
    }
}

// =========================
// LOAD WOW DATA
// =========================
async function loadWowData() {
    console.log('📂 Loading WOW data...');
    
    const data = await fetchData(DATA_URLS.wowData, 'wow_rss_data.json');
    
    if (data) {
        wowData = data;
        console.log(`✅ Loaded wow.xxx data: ${wowData.totalScenes || 0} scenes`);
    }
}

// =========================
// INITIALIZE DATA ON STARTUP
// =========================
async function initializeData() {
    console.log('🚀 Initializing data...');
    await loadStashData();
    await loadWowData();
    console.log('✅ Data initialization complete!');
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

// =========================
// DATABASE CONNECTION (for ratings/favorites only)
// =========================
if (!process.env.DATABASE_URL) {
    console.error('❌ FATAL ERROR: DATABASE_URL environment variable is required!');
    process.exit(1);
}

let db;

try {
    const url = new URL(process.env.DATABASE_URL);
    console.log('🔍 Host:', url.hostname);
    console.log('🔍 Port:', url.port);
    console.log('🔍 Database:', url.pathname.substring(1));

    const { Pool } = require('pg');
    db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
    });
    console.log('✅ PostgreSQL connection pool created (for ratings/favorites)');
} catch (error) {
    console.error('❌ Error creating PostgreSQL connection pool:', error.message);
    process.exit(1);
}

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
// SEARCH FUNCTIONS (LOCAL JSON)
// =========================

function searchPerformersLocal(searchTerm) {
    if (!searchTerm || searchTerm.length < 2) return [];
    
    const term = searchTerm.toLowerCase();
    return performerList.filter(p => {
        const nameMatch = p.name.toLowerCase().includes(term);
        const aliasMatch = p.aliases && p.aliases.some(a => a.toLowerCase().includes(term));
        return nameMatch || aliasMatch;
    });
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
// SEARCH STUDIOS API - SHOW ALL STUDIOS
// =========================
app.get('/api/search/studios', auth.requireAuth, (req, res) => {
    const query = req.query.q || '';
    
    try {
        const studios = Object.values(studioMap)
            .filter(s => s && s.id && s.name)
            .map(s => ({
                id: s.id,
                name: s.name,
                scene_count: s.scenes ? s.scenes.length : 0
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        
        console.log(`📊 Total studios: ${studios.length}`);
        
        if (!query || query.length < 2) {
            return res.json({ studios: studios });
        }
        
        const term = query.toLowerCase();
        const results = studios.filter(s => s.name.toLowerCase().includes(term));
        res.json({ studios: results });
    } catch (error) {
        console.error('❌ Studio search error:', error.message);
        res.json({ studios: [] });
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
// SEARCH PERFORMER - POST ROUTE
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
        const userData = await getUserData();
        const searchResults = searchPerformersLocal(searchTerm.trim());
        
        if (searchResults.length === 0) {
            return res.render('index', {
                title: 'Performer Viewer',
                performers: [],
                searchTerm,
                error: 'No performers found'
            });
        }
        
        const performers = searchResults.slice(0, 20).map(performer => ({
            ...performer,
            rating: userData.performerRatings[performer.id] || null,
            isFavorited: userData.favoritePerformers.includes(performer.id)
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
// ADVANCED SEARCH API
// =========================
app.get('/api/search/advanced', auth.requireAuth, async (req, res) => {
    const { studios = '', tier = '', favorite = '', match = 'any', page = 1, perPage = 50 } = req.query;
    const userData = await getUserData();
    const studioNames = studios ? studios.split(',') : [];
    const offset = (parseInt(page) - 1) * parseInt(perPage);
    
    console.log(`🔍 Searching for performers in studios: ${studioNames.join(', ')}`);
    console.log(`📊 Match type: ${match}`);
    console.log(`📊 SQL Ratings count: ${Object.keys(userData.performerRatings).length}`);
    
    if (studioNames.length === 0) {
        return res.json({ success: true, performers: [], total: 0, page: 1, totalPages: 0 });
    }
    
    let results = [];
    
    for (const pid in performerMap) {
        const item = performerMap[pid];
        if (!item || !item.performer || !item.scenes || !Array.isArray(item.scenes)) {
            continue;
        }
        
        const matchedStudios = [];
        for (const studioName of studioNames) {
            const hasStudio = item.scenes.some(scene => 
                scene && scene.studio && scene.studio.name && 
                scene.studio.name.toLowerCase() === studioName.toLowerCase()
            );
            if (hasStudio) {
                matchedStudios.push(studioName);
            }
        }
        
        let include = false;
        if (match === 'any' && matchedStudios.length > 0) {
            include = true;
        } else if (match === 'all' && matchedStudios.length === studioNames.length) {
            include = true;
        } else if (match === 'exact' && matchedStudios.length === studioNames.length && matchedStudios.length === studioNames.length) {
            include = true;
        }
        
        if (include) {
            const rating = userData.performerRatings ? userData.performerRatings[pid] : null;
            const isFavorited = userData.favoritePerformers ? userData.favoritePerformers.includes(pid) : false;
            
            results.push({
                performer: {
                    id: item.performer.id,
                    name: item.performer.name,
                    gender: item.performer.gender,
                    age: item.performer.age,
                    height: item.performer.height,
                    scene_count: item.scenes.length,
                    country: item.performer.country,
                    ethnicity: item.performer.ethnicity,
                    aliases: item.performer.aliases || [],
                    is_favorite: item.performer.is_favorite || false,
                    images: item.performer.images || [],
                    rating: rating,
                    is_favorited: isFavorited
                },
                matchedStudios: matchedStudios,
                matchedCount: matchedStudios.length,
                performerId: pid
            });
        }
    }
    
    console.log(`📊 Found ${results.length} performers`);
    console.log(`📊 With ratings: ${results.filter(r => r.performer.rating !== null).length}`);
    
    results.sort((a, b) => b.matchedCount - a.matchedCount);
    
    if (tier && tier !== 'all') {
        if (tier === 'rated') {
            results = results.filter(r => r.performer.rating !== null && r.performer.rating !== undefined);
        } else if (tier === 'unrated') {
            results = results.filter(r => r.performer.rating === null || r.performer.rating === undefined);
        } else {
            results = results.filter(r => r.performer.rating === tier);
        }
    }
    
    if (favorite === 'true') {
        results = results.filter(r => r.performer.is_favorited === true);
    } else if (favorite === 'false') {
        results = results.filter(r => r.performer.is_favorited === false);
    }
    
    const formattedResults = results.map(r => ({
        id: r.performer.id,
        name: r.performer.name,
        gender: r.performer.gender,
        age: r.performer.age,
        height: r.performer.height,
        scene_count: r.performer.scene_count,
        country: r.performer.country,
        ethnicity: r.performer.ethnicity,
        aliases: r.performer.aliases || [],
        is_favorite: r.performer.is_favorite || false,
        images: r.performer.images || [],
        rating: r.performer.rating,
        is_favorited: r.performer.is_favorited,
        studios: r.matchedStudios
    }));
    
    if (formattedResults.length > 0) {
        console.log(`📊 First result: ${formattedResults[0].name}, rating: ${formattedResults[0].rating}`);
        console.log(`📊 Matched studios: ${formattedResults[0].studios.join(', ')}`);
    }
    
    const total = formattedResults.length;
    const paginated = formattedResults.slice(offset, offset + parseInt(perPage));
    
    res.json({
        success: true,
        performers: paginated,
        total: total,
        page: parseInt(page),
        perPage: parseInt(perPage),
        totalPages: Math.ceil(total / parseInt(perPage))
    });
});

// =========================
// PERFORMER PROFILE
// =========================
app.get('/performer/:id', auth.requireAuth, async (req, res) => {
    const performerId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const userData = await getUserData();
    
    try {
        const item = performerMap[performerId];
        if (!item || !item.performer) {
            return res.status(404).send('Performer not found');
        }
        
        const performer = {
            id: item.performer.id,
            name: item.performer.name,
            gender: item.performer.gender,
            age: item.performer.age,
            height: item.performer.height,
            scene_count: (item.scenes && Array.isArray(item.scenes)) ? item.scenes.length : 0,
            country: item.performer.country,
            ethnicity: item.performer.ethnicity,
            aliases: item.performer.aliases || [],
            is_favorite: item.performer.is_favorite || false,
            images: item.performer.images || []
        };
        
        const allScenes = (item.scenes && Array.isArray(item.scenes)) ? item.scenes : [];
        const total = allScenes.length;
        const startIndex = (page - 1) * perPage;
        const endIndex = Math.min(startIndex + perPage, total);
        const paginatedScenes = allScenes.slice(startIndex, endIndex);
        const totalPages = Math.ceil(total / perPage) || 1;
        
        const scenesWithUserData = paginatedScenes.map(scene => ({
            ...scene,
            isFavorited: userData.favoriteScenes.includes(scene.id)
        }));
        
        res.render('performer', {
            title: performer.name,
            performer: performer,
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
app.get('/scene/:id', auth.requireAuth, async (req, res) => {
    const sceneId = req.params.id;
    const userData = await getUserData();
    
    const scene = sceneMap[sceneId];
    if (!scene) {
        return res.status(404).send('Scene not found');
    }
    
    const performers = [];
    for (const pid in performerMap) {
        const item = performerMap[pid];
        if (item.scenes && Array.isArray(item.scenes) && item.scenes.some(s => s && s.id === sceneId)) {
            performers.push({
                id: item.performer.id,
                name: item.performer.name,
                images: item.performer.images || []
            });
        }
    }
    
    res.render('scene', {
        title: scene.title || 'Scene',
        scene: {
            ...scene,
            performers: performers.map(p => ({ performer: p }))
        },
        isFavorited: userData.favoriteScenes.includes(sceneId)
    });
});

// =========================
// STUDIO DETAILS PAGE
// =========================
app.get('/studio/:id', auth.requireAuth, (req, res) => {
    const studioId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const userData = getUserData();
    
    const studio = studioMap[studioId];
    if (!studio) {
        return res.status(404).send('Studio not found');
    }
    
    const allScenes = studio.scenes
        .map(sceneId => sceneMap[sceneId])
        .filter(scene => scene !== undefined && scene !== null);
    
    const scenesWithRatings = allScenes.map(scene => {
        const performersInScene = [];
        for (const pid in performerMap) {
            const item = performerMap[pid];
            if (item.scenes && Array.isArray(item.scenes) && item.scenes.some(s => s && s.id === scene.id)) {
                performersInScene.push(pid);
            }
        }
        
        const performerRatings = performersInScene
            .map(pid => userData.performerRatings[pid] || null)
            .filter(r => r !== null);
        
        const tier = performerRatings.length > 0 ? performerRatings.sort()[0] : null;
        
        return {
            ...scene,
            performerRating: tier,
            isFavorited: userData.favoriteScenes.includes(scene.id)
        };
    });
    
    const total = scenesWithRatings.length;
    const startIndex = (page - 1) * perPage;
    const endIndex = Math.min(startIndex + perPage, total);
    const paginatedScenes = scenesWithRatings.slice(startIndex, endIndex);
    const totalPages = Math.ceil(total / perPage);
    
    const performersSet = new Set();
    allScenes.forEach(scene => {
        for (const pid in performerMap) {
            const item = performerMap[pid];
            if (item.scenes && Array.isArray(item.scenes) && item.scenes.some(s => s && s.id === scene.id)) {
                performersSet.add(pid);
            }
        }
    });
    
    let studioImage = null;
    if (allScenes.length > 0 && allScenes[0].images && allScenes[0].images.length > 0) {
        studioImage = allScenes[0].images[0].url;
    }
    
    res.render('studio', {
        title: studio.name,
        studioName: studio.name,
        studioId: studio.id,
        studioImage: studioImage,
        totalScenes: total,
        performersCount: performersSet.size,
        scenes: paginatedScenes,
        allScenes: scenesWithRatings.slice(0, 500),
        currentPage: page,
        totalPages: totalPages,
        studioId: studioId,
        isFavorite: false
    });
});

// =========================
// ADVANCED SEARCH PAGE
// =========================
app.get('/advanced-search', auth.requireAuth, (req, res) => {
    res.render('advanced-search', { title: 'Advanced Studio Search' });
});

// =========================
// VIDEO MODE ROUTES
// =========================

// Get performer's wow.xxx scenes
app.get('/api/performer/:id/wow-scenes', auth.requireAuth, (req, res) => {
    const performerId = req.params.id;
    
    try {
        const item = performerMap[performerId];
        if (!item || !item.performer) {
            return res.json({ success: false, error: 'Performer not found' });
        }
        
        const performerName = item.performer.name;
        
        if (!wowData || !wowData.results) {
            return res.json({ success: true, scenes: [], performerName: performerName });
        }
        
        const performerResult = wowData.results.find(r => 
            r.performer && r.performer.name && 
            r.performer.name.toLowerCase() === performerName.toLowerCase()
        );
        
        if (!performerResult || !performerResult.scenes || performerResult.scenes.length === 0) {
            return res.json({ success: true, scenes: [], performerName: performerName });
        }
        
        const scenes = performerResult.scenes.map(scene => ({
            id: scene.videoId || 'unknown',
            title: scene.title || 'Untitled Scene',
            duration: scene.duration || '0:00',
            date: null,
            studio: scene.studio ? { name: scene.studio } : null,
            images: scene.thumbnail ? [{ url: scene.thumbnail }] : [],
            video720p: scene.video720p,
            isFavorited: false,
            performerName: performerName,
            wowUrl: scene.url,
            allQualities: scene.allQualities || []
        }));
        
        res.json({
            success: true,
            scenes: scenes,
            performerName: performerName,
            totalScenes: scenes.length,
            videosFound: performerResult.videosFound || 0
        });
        
    } catch (error) {
        console.error('❌ Error fetching wow scenes:', error.message);
        res.json({ success: false, error: error.message, scenes: [] });
    }
});

// Video mode page for performer with pagination
app.get('/performer/:id/videos', auth.requireAuth, async (req, res) => {
    const performerId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 24;
    const item = performerMap[performerId];
    
    if (!item || !item.performer) {
        return res.status(404).send('Performer not found');
    }
    
    try {
        const performerName = item.performer.name;
        let wowScenes = [];
        let totalWowScenes = 0;
        let videosFound = 0;
        let totalPages = 1;
        
        if (wowData && wowData.results) {
            const performerResult = wowData.results.find(r => 
                r.performer && r.performer.name && 
                r.performer.name.toLowerCase() === performerName.toLowerCase()
            );
            
            if (performerResult && performerResult.scenes) {
                const allScenes = performerResult.scenes.map(scene => ({
                    id: scene.videoId || 'unknown',
                    title: scene.title || 'Untitled Scene',
                    duration: scene.duration || '0:00',
                    studio: scene.studio ? { name: scene.studio } : null,
                    images: scene.thumbnail ? [{ url: scene.thumbnail }] : [],
                    video720p: scene.video720p,
                    url: scene.url,
                    allQualities: scene.allQualities || []
                }));
                
                totalWowScenes = allScenes.length;
                videosFound = performerResult.videosFound || 0;
                totalPages = Math.ceil(totalWowScenes / perPage);
                
                const startIndex = (page - 1) * perPage;
                const endIndex = Math.min(startIndex + perPage, totalWowScenes);
                wowScenes = allScenes.slice(startIndex, endIndex);
            }
        }
        
        res.render('performer-videos', {
            title: `${item.performer.name} - Videos`,
            performer: item.performer,
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
// Initialize data first, then start server
async function startServer() {
    try {
        await initializeData();
        
        app.listen(PORT, () => {
            console.log(`🚀 Server running at http://localhost:${PORT}`);
            console.log(`💾 Using JSON data for performers/scenes, SQL for ratings/favorites`);
            console.log(`🔒 Password protection enabled`);
            console.log(`📊 Advanced Search: http://localhost:${PORT}/advanced-search`);
            console.log(`🎬 Video Mode: http://localhost:${PORT}/performer/{id}/videos`);
        });
    } catch (error) {
        console.error('❌ Failed to initialize data:', error.message);
        process.exit(1);
    }
}

startServer();

process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    if (db) db.end();
    process.exit(0);
});