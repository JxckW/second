const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');

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
            }
        }
    });
} else {
    console.log('❌ .env file NOT found at:', envPath);
}

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// DATA STORAGE (in-memory cache)
// =========================
let performerList = [];
let performerMap = {};
let studioMap = {};
let sceneMap = {};
let wowData = null;
let dataLoaded = false;

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
        console.log('✅ Neon PostgreSQL connection pool created (for performer data)');
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
// LOAD DATA FROM NEON
// =========================
async function loadDataFromNeon() {
    if (!neonDb) {
        console.log('📂 Neon not available - using local JSON data');
        return false;
    }

    try {
        console.log('📂 Loading performer data from Neon...');
        
        const performers = await queryNeon('SELECT * FROM performers');
        console.log(`   Loaded ${performers.length} performers from Neon`);
        
        const scenes = await queryNeon('SELECT * FROM scenes');
        console.log(`   Loaded ${scenes.length} scenes from Neon`);
        
        const performerScenes = await queryNeon('SELECT * FROM performer_scenes');
        console.log(`   Loaded ${performerScenes.length} performer-scene relationships from Neon`);
        
        const wowVideos = await queryNeon('SELECT * FROM wow_videos');
        console.log(`   Loaded ${wowVideos.length} wow videos from Neon`);
        
        if (performers.length === 0) {
            console.log('⚠️ No data found in Neon - check your upload');
            return false;
        }

        performerMap = {};
        performerList = [];
        sceneMap = {};
        studioMap = {};
        
        // 1. Process performers
        performers.forEach(performer => {
            performerMap[performer.id] = {
                performer: performer,
                scenes: []
            };
            performerList.push({
                id: performer.id,
                name: performer.name,
                gender: performer.gender,
                age: performer.age,
                height: performer.height,
                scene_count: 0,
                country: performer.country,
                ethnicity: performer.ethnicity,
                aliases: parseAliases(performer.aliases),
                is_favorite: performer.is_favorite || false,
                images: performer.images ? JSON.parse(performer.images) : []
            });
        });

        // 2. Process scenes
        scenes.forEach(scene => {
            sceneMap[scene.id] = {
                id: scene.id,
                title: scene.title,
                date: scene.date,
                duration: scene.duration,
                studio: scene.studio_id ? {
                    id: scene.studio_id,
                    name: scene.studio_name
                } : null,
                images: scene.images ? JSON.parse(scene.images) : []
            };
            
            if (scene.studio_id) {
                if (!studioMap[scene.studio_id]) {
                    studioMap[scene.studio_id] = {
                        id: scene.studio_id,
                        name: scene.studio_name || 'Unknown Studio',
                        scenes: []
                    };
                }
                studioMap[scene.studio_id].scenes.push(scene.id);
            }
        });

        // 3. Build performer-scene relationships
        console.log(`   Building performer-scene relationships...`);
        let relationshipCount = 0;
        
        performerScenes.forEach(ps => {
            if (performerMap[ps.performer_id]) {
                const scene = sceneMap[ps.scene_id];
                if (scene) {
                    performerMap[ps.performer_id].scenes.push(scene);
                    relationshipCount++;
                }
            }
        });
        console.log(`   Created ${relationshipCount} performer-scene links`);

        // 4. Update performerList with correct scene counts
        performerList.forEach(p => {
            if (performerMap[p.id]) {
                p.scene_count = performerMap[p.id].scenes.length;
            }
        });

        // 5. Build wow data
        if (wowVideos.length > 0) {
            const wowResults = {};
            wowVideos.forEach(video => {
                const performerName = video.performer_name || 'Unknown';
                if (!wowResults[performerName]) {
                    wowResults[performerName] = {
                        performer: { name: performerName },
                        scenes: [],
                        totalScenes: 0,
                        videosFound: 0
                    };
                }
                wowResults[performerName].scenes.push({
                    videoId: null,
                    title: video.title,
                    url: video.url,
                    thumbnail: video.thumbnail,
                    duration: video.duration,
                    studio: video.studio,
                    video720p: video.video720p || video.video_url,
                    allQualities: video.all_qualities ? JSON.parse(video.all_qualities) : []
                });
                wowResults[performerName].totalScenes++;
                if (video.video720p) {
                    wowResults[performerName].videosFound++;
                }
            });
            
            wowData = {
                results: Object.values(wowResults),
                totalScenes: wowVideos.length
            };
            console.log(`   Built wow data: ${wowData.totalScenes} scenes`);
        }

        console.log(`✅ Data loaded from Neon: ${performerList.length} performers, ${Object.keys(sceneMap).length} scenes, ${relationshipCount} links`);
        return true;
        
    } catch (error) {
        console.error('❌ Error loading data from Neon:', error.message);
        console.error(error.stack);
        return false;
    }
}

// =========================
// LOAD DATA FROM LOCAL JSON (FALLBACK)
// =========================
function loadDataFromJSON() {
    console.log('📂 Loading data from local JSON files...');
    
    const DATA_FILE = path.join(__dirname, 'stashdb_data.json');
    const WOW_DATA_FILE = path.join(__dirname, 'wow.xxx/data/wow_rss_data.json');

    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            
            performerMap = {};
            performerList = [];
            sceneMap = {};
            studioMap = {};
            
            let performerData = parsed;
            if (parsed.data && Array.isArray(parsed.data)) {
                performerData = parsed.data;
            } else if (parsed.performers && Array.isArray(parsed.performers)) {
                performerData = parsed.performers;
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
            }
            
            console.log(`✅ Loaded ${performerList.length} performers from JSON`);
            console.log(`✅ ${Object.keys(sceneMap).length} scenes from JSON`);
            console.log(`✅ ${Object.keys(studioMap).length} studios from JSON`);
        } else {
            console.log('⚠️ stashdb_data.json not found');
        }
        
        if (fs.existsSync(WOW_DATA_FILE)) {
            const wowRaw = fs.readFileSync(WOW_DATA_FILE, 'utf8');
            wowData = JSON.parse(wowRaw);
            console.log(`✅ Loaded wow.xxx data: ${wowData.totalScenes || 0} scenes`);
        } else {
            console.log('⚠️ wow_rss_data.json not found');
        }
        
    } catch (error) {
        console.error('❌ Error loading local JSON data:', error.message);
    }
}

// =========================
// INITIALIZE DATA ON STARTUP
// =========================
async function initializeData() {
    console.log('🚀 Initializing data...');
    
    if (neonDb) {
        const neonSuccess = await loadDataFromNeon();
        if (neonSuccess) {
            dataLoaded = true;
            console.log('✅ Data initialization complete (from Neon)');
            return;
        }
    }
    
    loadDataFromJSON();
    dataLoaded = true;
    console.log('✅ Data initialization complete (from local JSON)');
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
console.log('🔍 NEON_DATABASE_URL exists?', !!process.env.NEON_DATABASE_URL);
console.log('🔍 NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('🔍 PORT:', PORT);
console.log('🔍 === DEBUGGING END ===');

// =========================
// SEARCH FUNCTIONS
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

app.post('/api/favorite/performer', auth.requireAuth, async (req, res) => {
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

app.post('/api/favorite/scene', auth.requireAuth, async (req, res) => {
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
// SEARCH STUDIOS API
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

app.get('/', auth.requireAuth, (req, res) => {
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
        } else if (match === 'exact' && matchedStudios.length === studioNames.length) {
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
        
        let aliases = item.performer.aliases || [];
        if (typeof aliases === 'string') {
            try {
                aliases = JSON.parse(aliases);
            } catch (e) {
                aliases = [];
            }
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
            aliases: aliases,
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

// =========================
// VIDEO PROXY - Streams video from wow.xxx
// =========================
app.get('/api/video/proxy', auth.requireAuth, async (req, res) => {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
        return res.status(400).json({ error: 'No video URL provided' });
    }
    
    try {
        console.log(`📹 Proxying video: ${videoUrl.substring(0, 80)}...`);
        
        const response = await fetch(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.wow.xxx/',
                'Origin': 'https://www.wow.xxx',
                'Accept': 'video/mp4, video/webm, video/*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        // Set headers for video streaming
        res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
        res.setHeader('Content-Length', response.headers.get('content-length'));
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        // Stream the video
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
                    });
                }
                push();
            }
        });
        
        stream.pipeTo(res);
        
    } catch (error) {
        console.error('❌ Video proxy error:', error.message);
        res.status(500).json({ error: 'Failed to proxy video' });
    }
});

// =========================
// VIDEO MODE PAGE
// =========================
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
async function startServer() {
    try {
        await initializeData();
        
        app.listen(PORT, () => {
            console.log(`🚀 Server running at http://localhost:${PORT}`);
            console.log(`💾 Data source: ${neonDb ? 'Neon (primary) + Miget (ratings)' : 'Local JSON + Miget (ratings)'}`);
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
    if (migetDb) migetDb.end();
    if (neonDb) neonDb.end();
    process.exit(0);
});