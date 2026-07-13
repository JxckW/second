// wow-rss-scraper.js
// COMPLETE SCRIPT - NO LIMITS - PROCESSES ALL PERFORMERS
// Run with: node wow-rss-scraper.js --batch --turbo

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// =========================
// CONFIGURATION
// =========================
const OUTPUT_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'wow_rss_data.json');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'scrape_progress.json');
const WOW_BASE = 'https://www.omg.xxx';
const MAX_PAGES = 20;

const STASHDB_FILE = path.join(__dirname, '..', 'stashdb_data.json');

// TURBO MODE CONFIG
const CONFIG = {
    turboDelay: {
        betweenPages: 100,
        betweenScenes: 50,
        betweenPerformers: 500
    },
    slowDelay: {
        betweenPages: 2000,
        betweenScenes: 1000,
        betweenPerformers: 3000
    },
    retry: {
        maxRetries: Infinity,
        baseDelay: 1000,
        maxDelay: 30000,
        backoffMultiplier: 1.5
    },
    batch: {
        enabled: true,
        size: 10,
        delayBetweenBatches: 200
    },
    connection: {
        keepAlive: true,
        maxSockets: 20,
        maxFreeSockets: 10,
        timeout: 30000
    }
};

// =========================
// HTTP AGENT WITH CONNECTION POOLING
// =========================
const https = require('https');

const agent = new https.Agent({
    keepAlive: CONFIG.connection.keepAlive,
    maxSockets: CONFIG.connection.maxSockets,
    maxFreeSockets: CONFIG.connection.maxFreeSockets,
    timeout: CONFIG.connection.timeout
});

// Rotating user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:108.0) Gecko/20100101 Firefox/108.0'
];

let currentUserAgentIndex = 0;
let errorCount = 0;
let totalRequests = 0;
let successfulRequests = 0;
let startTime = null;

function getNextUserAgent() {
    const ua = USER_AGENTS[currentUserAgentIndex % USER_AGENTS.length];
    currentUserAgentIndex++;
    return ua;
}

// =========================
// ADAPTIVE DELAY
// =========================
function getDelay(type) {
    if (errorCount === 0) {
        return CONFIG.turboDelay[type] || 50;
    }
    if (errorCount >= 5) {
        return CONFIG.slowDelay[type] || 2000;
    }
    const baseDelay = CONFIG.turboDelay[type] || 50;
    return Math.min(baseDelay * (1 + errorCount * 0.5), CONFIG.slowDelay[type] || 2000);
}

function recordError() {
    errorCount++;
    if (errorCount === 3) {
        console.log(`   ⚠️ 3 errors detected, slowing down...`);
    }
    if (errorCount === 10) {
        console.log(`   ⚠️ 10 errors detected, significant slowdown...`);
    }
}

function recordSuccess() {
    totalRequests++;
    successfulRequests++;
    if (errorCount > 0) {
        errorCount--;
        if (errorCount < 3) {
            console.log(`   ✅ Errors reduced, speeding up...`);
        }
    }
}

// =========================
// ENSURE DIRECTORIES
// =========================
function ensureDirectories() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        console.log(`📁 Created: ${OUTPUT_DIR}`);
    }
}

// =========================
// LOAD PERFORMERS
// =========================
function loadPerformers() {
    console.log('📂 Loading performers from stashdb_data.json...');
    
    if (!fs.existsSync(STASHDB_FILE)) {
        console.error(`❌ File not found: ${STASHDB_FILE}`);
        return [];
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(STASHDB_FILE, 'utf8'));
        const performers = [];
        
        let performerData = data;
        if (data.data && Array.isArray(data.data)) {
            performerData = data.data;
        } else if (data.performers && Array.isArray(data.performers)) {
            performerData = data.performers;
        }
        
        if (Array.isArray(performerData)) {
            performerData.forEach(item => {
                const performer = item.performer || item;
                if (performer && performer.name) {
                    performers.push({
                        id: performer.id,
                        name: performer.name,
                        slug: performer.name.toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, ''),
                        scene_count: performer.scene_count || 0
                    });
                }
            });
        }
        
        console.log(`✅ Loaded ${performers.length} performers`);
        return performers;
    } catch (error) {
        console.error('❌ Error loading performers:', error.message);
        return [];
    }
}

// =========================
// LOAD/SAVE PROGRESS
// =========================
function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// =========================
// INFINITE RETRY WITH ADAPTIVE BACKOFF
// =========================
async function scrapeWithRetry(url, context = '', retryCount = 0) {
    const maxDelay = CONFIG.retry.maxDelay;
    const baseDelay = CONFIG.retry.baseDelay;
    const backoffMultiplier = CONFIG.retry.backoffMultiplier;
    
    let delay = Math.min(baseDelay * Math.pow(backoffMultiplier, retryCount), maxDelay);
    const jitter = Math.random() * 500;
    delay = delay + jitter;
    
    try {
        const userAgent = getNextUserAgent();
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 30000,
            maxRedirects: 5,
            httpsAgent: agent,
            validateStatus: function (status) {
                return status < 500;
            }
        });
        
        if (response.status === 503 || response.status === 429) {
            throw new Error(`Rate limited (${response.status})`);
        }
        
        if (response.data && response.data.includes('website temporary unavailable')) {
            throw new Error('Site blocking');
        }
        
        recordSuccess();
        return response;
        
    } catch (error) {
        recordError();
        
        const isRetryable = error.message.includes('503') || 
                           error.message.includes('429') ||
                           error.message.includes('rate limit') ||
                           error.message.includes('blocked') ||
                           error.message.includes('timeout') ||
                           error.message.includes('ECONNRESET') ||
                           error.message.includes('ETIMEDOUT') ||
                           error.message.includes('website temporary unavailable');
        
        if (!isRetryable && retryCount > 0) {
            throw error;
        }
        
        if (retryCount % 5 === 0) {
            const delaySeconds = (delay / 1000).toFixed(1);
            console.log(`      ⏳ ${context} retry ${retryCount + 1} in ${delaySeconds}s`);
        }
        
        await new Promise(r => setTimeout(r, delay));
        return await scrapeWithRetry(url, context, retryCount + 1);
    }
}

// =========================
// GET PAGE URL
// =========================
function getPerformerPageUrl(performerName, pageNum = 1) {
    const slug = performerName.toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');
    if (pageNum === 1) {
        return `${WOW_BASE}/models/${slug}/latest-updates/`;
    }
    return `${WOW_BASE}/models/${slug}/latest-updates/${pageNum}/`;
}

// =========================
// PARSE HTML
// =========================
function parseHTML(html, performerName) {
    const $ = cheerio.load(html);
    const scenes = [];
    
    $('.list-videos .item, .video-item, .thumb-item').each((i, el) => {
        const link = $(el).find('a.thumb_img, a[href*="/videos/"]');
        const href = link.attr('href') || '';
        
        if (!href || !href.includes('/videos/')) return;
        
        const title = $(el).find('.thumb_title, .title, .item-info .title').text().trim() || 
                      link.attr('title') || 'Untitled Scene';
        
        const img = $(el).find('img.thumb').attr('src') || 
                   $(el).find('img.thumb').attr('data-src') || '';
        
        const duration = $(el).find('.duration').text().trim().replace('Full Video', '').trim();
        const videoId = href.match(/\/videos\/[^\/]+\/(\d+)\//)?.[1] || null;
        const rating = $(el).find('.rating').text().trim();
        const views = $(el).find('.views').text().trim();
        const studio = $(el).find('.thumb_cs, a[href*="/sites/"]').text().trim();
        
        scenes.push({
            url: href,
            videoId: videoId,
            title: title,
            thumbnail: img,
            duration: duration,
            rating: rating || null,
            views: views || null,
            studio: studio || null,
            performer: performerName,
            video720p: null,
            allQualities: [],
            videoSources: []
        });
    });
    
    return scenes;
}

// =========================
// FETCH ALL PAGES IN PARALLEL (TURBO MODE)
// =========================
async function scrapePerformerAllPagesTurbo(performerName) {
    console.log(`   📡 Fetching all pages (TURBO MODE)...`);
    
    const url1 = getPerformerPageUrl(performerName, 1);
    let response1;
    
    try {
        response1 = await scrapeWithRetry(url1, 'Page 1');
    } catch (error) {
        console.log(`   ❌ Failed to fetch page 1: ${error.message}`);
        return [];
    }
    
    const $ = cheerio.load(response1.data);
    const scenes1 = parseHTML(response1.data, performerName);
    let allScenes = [...scenes1];
    
    // Check how many pages exist
    const paginationText = $('.pagination, .page-numbers').text();
    const pageNumbers = paginationText.match(/\d+/g);
    let totalPages = 1;
    
    if (pageNumbers) {
        const nums = pageNumbers.map(Number).filter(n => n > 0);
        if (nums.length > 0) {
            totalPages = Math.max(...nums);
        }
    }
    
    const lastLink = $('a:contains("Last")').attr('href');
    if (lastLink) {
        const lastPageMatch = lastLink.match(/\/(\d+)\/$/);
        if (lastPageMatch) {
            totalPages = Math.max(totalPages, parseInt(lastPageMatch[1]));
        }
    }
    
    totalPages = Math.min(totalPages, MAX_PAGES);
    console.log(`      📄 Found ${totalPages} total pages`);
    
    if (totalPages <= 1) {
        console.log(`      📊 Total scenes: ${allScenes.length}`);
        return allScenes;
    }
    
    console.log(`      ⚡ Fetching pages 2-${totalPages} in parallel...`);
    
    const pagePromises = [];
    for (let page = 2; page <= totalPages; page++) {
        const url = getPerformerPageUrl(performerName, page);
        pagePromises.push(
            scrapeWithRetry(url, `Page ${page}`)
                .then(response => {
                    const scenes = parseHTML(response.data, performerName);
                    console.log(`         Page ${page}: ${scenes.length} scenes`);
                    return scenes;
                })
                .catch(error => {
                    console.log(`         Page ${page}: Error - ${error.message}`);
                    return [];
                })
        );
    }
    
    const pageResults = await Promise.all(pagePromises);
    
    for (const scenes of pageResults) {
        allScenes = allScenes.concat(scenes);
    }
    
    const uniqueScenes = [];
    const seenUrls = new Set();
    for (const scene of allScenes) {
        if (!seenUrls.has(scene.url)) {
            seenUrls.add(scene.url);
            uniqueScenes.push(scene);
        }
    }
    
    console.log(`      📊 Total unique scenes: ${uniqueScenes.length}`);
    return uniqueScenes;
}

// =========================
// EXTRACT 720p VIDEO (TURBO MODE)
// =========================
async function extractSceneVideoTurbo(sceneUrl, sceneIndex, totalScenes) {
    try {
        const response = await scrapeWithRetry(
            sceneUrl, 
            `Scene ${sceneIndex + 1}/${totalScenes}`
        );
        
        const $ = cheerio.load(response.data);
        let video720p = null;
        let allQualities = [];
        let videoSources = [];
        
        $('video source, a[href*="get_file"]').each((i, el) => {
            const src = $(el).attr('src') || $(el).attr('href');
            if (!src || !src.includes('get_file')) return;
            
            const qualityMatch = src.match(/_(\d+)p/);
            const quality = qualityMatch ? qualityMatch[1] : 'unknown';
            allQualities.push(quality);
            videoSources.push({ url: src, quality: quality });
            
            if (quality === '720' && !video720p) {
                video720p = src;
            }
        });
        
        if (!video720p) {
            $('video').each((i, el) => {
                const src = $(el).attr('src');
                if (src && src.includes('get_file')) {
                    const qualityMatch = src.match(/_(\d+)p/);
                    if (qualityMatch && qualityMatch[1] === '720') {
                        video720p = src;
                        if (!allQualities.includes('720')) {
                            allQualities.push('720');
                        }
                    }
                }
            });
        }
        
        if (!video720p && videoSources.length > 0) {
            const qualityPriority = ['2160', '1080', '720', '480', '360'];
            for (const q of qualityPriority) {
                const found = videoSources.find(s => s.quality === q);
                if (found) {
                    video720p = found.url;
                    break;
                }
            }
            if (!video720p) {
                video720p = videoSources[0].url;
            }
        }
        
        recordSuccess();
        return { 
            video720p: video720p, 
            allQualities: allQualities,
            videoSources: videoSources
        };
        
    } catch (error) {
        return { video720p: null, allQualities: [], videoSources: [], error: error.message };
    }
}

// =========================
// PROCESS PERFORMER (TURBO MODE)
// =========================
async function processPerformerTurbo(performer, extractVideos = true) {
    console.log(`\n📹 Processing: ${performer.name}`);
    console.log(`   ID: ${performer.id || 'N/A'}`);
    console.log(`   StashDB scenes: ${performer.scene_count || 'N/A'}`);
    console.log(`   ⚡ TURBO MODE: ${CONFIG.turboDelay.betweenScenes}ms between batches`);
    console.log(`   📦 Batch size: ${CONFIG.batch.size} scenes in parallel`);
    
    const scenes = await scrapePerformerAllPagesTurbo(performer.name);
    
    if (!scenes || scenes.length === 0) {
        console.log(`   ⚠️ No scenes found for ${performer.name}`);
        return { performer, scenes: [], totalScenes: 0, videosFound: 0, success: true };
    }
    
    let videosFound = 0;
    const allScenes = [];
    
    if (extractVideos) {
        console.log(`   🎬 Extracting 720p videos for ${scenes.length} scenes (TURBO MODE)...`);
        
        const batchSize = CONFIG.batch.size;
        const startBatchTime = Date.now();
        
        for (let i = 0; i < scenes.length; i += batchSize) {
            const batch = scenes.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(scenes.length / batchSize);
            
            const batchPromises = batch.map((scene, idx) => {
                const sceneIndex = i + idx;
                return extractSceneVideoTurbo(scene.url, sceneIndex, scenes.length);
            });
            
            const batchResults = await Promise.all(batchPromises);
            
            for (let j = 0; j < batch.length; j++) {
                const scene = batch[j];
                const videoData = batchResults[j];
                
                if (videoData.video720p) {
                    videosFound++;
                }
                
                allScenes.push({
                    ...scene,
                    video720p: videoData.video720p,
                    allQualities: videoData.allQualities || [],
                    videoSources: videoData.videoSources || []
                });
            }
            
            const elapsed = (Date.now() - startBatchTime) / 1000;
            const rate = (i + batch.length) / elapsed;
            
            if (batchNum % 5 === 0 || batchNum === totalBatches) {
                console.log(`         📦 Batch ${batchNum}/${totalBatches} done (${videosFound} videos found, ${rate.toFixed(1)} scenes/sec)`);
            }
            
            const delay = getDelay('betweenScenes');
            await new Promise(r => setTimeout(r, delay));
        }
        
        const totalTime = ((Date.now() - startBatchTime) / 1000).toFixed(1);
        console.log(`   📊 Videos with 720p: ${videosFound}/${scenes.length} (${totalTime}s)`);
        console.log(`   📊 Average speed: ${(scenes.length / totalTime).toFixed(1)} scenes/sec`);
    } else {
        allScenes.push(...scenes);
    }
    
    return {
        performer: performer,
        scenes: allScenes,
        totalScenes: allScenes.length,
        videosFound: videosFound,
        success: true
    };
}

// =========================
// SAVE RESULTS
// =========================
function saveResults(performerName, scenes, allResults) {
    const output = {
        timestamp: new Date().toISOString(),
        totalPerformers: allResults ? allResults.length : 1,
        totalScenes: scenes ? scenes.length : 0,
        totalVideosFound: allResults ? allResults.reduce((sum, r) => sum + r.videosFound, 0) : 0,
        totalRequests: totalRequests,
        successfulRequests: successfulRequests,
        results: allResults || [{ 
            performer: performerName, 
            scenes: scenes || [], 
            totalScenes: scenes ? scenes.length : 0,
            videosFound: 0
        }]
    };
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`\n💾 Saved to: ${OUTPUT_FILE}`);
}

// =========================
// MAIN
// =========================
async function main() {
    startTime = Date.now();
    
    console.log('🚀 Starting TURBO WOW.XXX scraper...');
    console.log(`⏰ Started at: ${new Date().toISOString()}`);
    console.log(`⚡ TURBO MODE: 50ms between batches`);
    console.log(`📦 Batch size: ${CONFIG.batch.size} scenes in parallel`);
    console.log(`🔄 Infinite retry with adaptive backoff`);
    console.log(`🌐 Connection pooling: ${CONFIG.connection.maxSockets} sockets\n`);
    
    ensureDirectories();
    
    const args = process.argv.slice(2);
    
    const isBatch = args.includes('--batch');
    const noVideos = args.includes('--no-videos');
    const targetPerformer = args.find(arg => !arg.startsWith('--'));
    
    // =========================
    // BATCH MODE - PROCESS ALL PERFORMERS
    // =========================
    if (isBatch) {
        console.log('📊 Batch mode enabled');
        const performers = loadPerformers();
        
        if (performers.length === 0) {
            console.log('❌ No performers found!');
            return;
        }
        
        // PROCESS ALL PERFORMERS - NO LIMITS
        const performersToProcess = performers;
        console.log(`📊 Processing ${performersToProcess.length} performers (ALL PERFORMERS)`);
        console.log(`📹 Auto-extracting video URLs for ALL scenes\n`);
        
        const progress = loadProgress();
        const startIndex = progress.lastIndex || 0;
        const allResults = [];
        const extractVideos = !noVideos;
        
        for (let i = startIndex; i < performersToProcess.length; i++) {
            const performer = performersToProcess[i];
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📹 ${i + 1}/${performersToProcess.length}: ${performer.name}`);
            console.log(`${'='.repeat(60)}`);
            
            const result = await processPerformerTurbo(performer, extractVideos);
            allResults.push(result);
            
            progress.lastIndex = i + 1;
            progress.lastPerformer = performer.name;
            saveProgress(progress);
            
            console.log(`   💾 Progress saved (${i + 1}/${performersToProcess.length})`);
            
            const delay = getDelay('betweenPerformers');
            await new Promise(r => setTimeout(r, delay));
        }
        
        const finalOutput = {
            timestamp: new Date().toISOString(),
            totalPerformers: performersToProcess.length,
            totalScenes: allResults.reduce((sum, r) => sum + r.totalScenes, 0),
            totalVideosFound: allResults.reduce((sum, r) => sum + r.videosFound, 0),
            totalRequests: totalRequests,
            successfulRequests: successfulRequests,
            results: allResults
        };
        
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalOutput, null, 2));
        console.log(`\n💾 Final results saved to: ${OUTPUT_FILE}`);
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n📊 ===== FINAL SUMMARY =====');
        console.log(`👤 Total performers: ${performersToProcess.length}`);
        console.log(`🎬 Total scenes: ${finalOutput.totalScenes}`);
        console.log(`📹 Videos with 720p: ${finalOutput.totalVideosFound}`);
        console.log(`⏱️ Total time: ${totalTime}s (${(totalTime / 60).toFixed(1)} min)`);
        console.log(`📊 Speed: ${(finalOutput.totalScenes / totalTime).toFixed(1)} scenes/sec`);
        console.log(`📁 Output: ${OUTPUT_FILE}`);
        console.log('\n🎉 Scraping complete!');
        return;
    }
    
    // =========================
    // SINGLE PERFORMER MODE
    // =========================
    if (targetPerformer) {
        console.log(`🎯 Target: ${targetPerformer}`);
        const extractVideos = !noVideos;
        const result = await processPerformerTurbo({ name: targetPerformer, id: null }, extractVideos);
        saveResults(targetPerformer, result.scenes, [result]);
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n📊 ===== SUMMARY =====');
        console.log(`🎬 Total scenes: ${result.totalScenes}`);
        if (extractVideos) {
            console.log(`📹 Videos with 720p: ${result.videosFound}`);
        }
        console.log(`⏱️ Time: ${totalTime}s`);
        console.log(`📁 Output: ${OUTPUT_FILE}`);
        console.log('\n🎉 Scraping complete!');
        return;
    }
    
    // =========================
    // SHOW USAGE
    // =========================
    console.log('\n📋 Usage:');
    console.log('  BATCH MODE (ALL PERFORMERS):');
    console.log('    node wow-rss-scraper.js --batch --turbo');
    console.log('');
    console.log('  Single performer:');
    console.log('    node wow-rss-scraper.js "Chloe Temple"');
    console.log('');
    console.log('  Skip video extraction:');
    console.log('    node wow-rss-scraper.js "Chloe Temple" --no-videos');
    console.log('');
    console.log('  Examples:');
    console.log('    node wow-rss-scraper.js --batch --turbo');
    console.log('    node wow-rss-scraper.js "Chloe Temple" --turbo');
}

// =========================
// RUN
// =========================
main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});