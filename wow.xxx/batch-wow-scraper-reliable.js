// batch-wow-scraper-reliable.js
// Reliable batch scraper with retry logic and no skipping
// Run with: node batch-wow-scraper-reliable.js "Chloe Temple"

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIGURATION
// =========================
const STASHDB_FILE = path.join(__dirname, '..', 'stashdb_data.json');
const OUTPUT_DIR = path.join(__dirname, 'data');
const WOW_DATA_FILE = path.join(OUTPUT_DIR, 'wow_videos_data.json');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'scrape_progress.json');
const FAILED_SCENES_FILE = path.join(OUTPUT_DIR, 'failed_scenes.json');

const WOW_BASE_URL = 'https://www.wow.xxx';
const SCENES_PER_PAGE = 24;
const MAX_PAGES = 20;
const MAX_RETRIES = 3;
const CONCURRENT_SCENES = 3;
const DELAY_BETWEEN_REQUESTS = 500;

const args = process.argv.slice(2);
const TARGET_PERFORMER = args.length > 0 ? args.join(' ') : null;

// =========================
// ENSURE DIRECTORIES
// =========================
function ensureDirectories() {
    const dirs = [
        OUTPUT_DIR,
        path.join(OUTPUT_DIR, 'html'),
        path.join(OUTPUT_DIR, 'performers'),
        path.join(OUTPUT_DIR, 'scene_data')
    ];
    
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`📁 Created: ${dir}`);
        }
    });
}

// =========================
// LOAD PERFORMERS FROM STASHDB
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
                        gender: performer.gender,
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
// LOAD/SAVE FAILED SCENES
// =========================
function loadFailedScenes() {
    if (fs.existsSync(FAILED_SCENES_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(FAILED_SCENES_FILE, 'utf8'));
        } catch (e) {
            return { scenes: [] };
        }
    }
    return { scenes: [] };
}

function saveFailedScenes(failed) {
    fs.writeFileSync(FAILED_SCENES_FILE, JSON.stringify(failed, null, 2));
}

// =========================
// CREATE PERFORMER URL
// =========================
function getPerformerUrl(performer) {
    return `${WOW_BASE_URL}/models/${performer.slug}/latest-updates/`;
}

// =========================
// RELIABLE: EXTRACT ALL SCENE LINKS WITH RETRY
// =========================
async function extractAllSceneLinks(page, performer) {
    const url = getPerformerUrl(performer);
    console.log(`   📄 Loading: ${url}`);
    
    let allScenes = [];
    const seenUrls = new Set(); // Track unique scene URLs
    let currentPage = 1;
    let hasMore = true;
    let retryCount = 0;
    let consecutiveEmptyPages = 0;
    
    // Navigate to first page with retry
    while (retryCount < MAX_RETRIES) {
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            await page.waitForTimeout(2000);
            
            // Check for Cloudflare
            const content = await page.content();
            if (content.includes('cf-browser-verification') || 
                content.includes('Cloudflare') ||
                content.includes('Checking your browser')) {
                console.log('   ⚠️ Cloudflare detected, waiting...');
                await page.waitForTimeout(15000);
                // Try again after waiting
                continue;
            }
            
            retryCount = 0; // Reset retry count on success
            break;
            
        } catch (error) {
            retryCount++;
            console.log(`   ⚠️ Load attempt ${retryCount}/${MAX_RETRIES} failed: ${error.message}`);
            if (retryCount >= MAX_RETRIES) {
                console.log(`   ❌ Failed to load page after ${MAX_RETRIES} attempts`);
                return [];
            }
            await page.waitForTimeout(5000);
        }
    }
    
    // Extract scenes from all pages
    while (hasMore && currentPage <= MAX_PAGES) {
        console.log(`   📄 Page ${currentPage}: Extracting scenes...`);
        
        try {
            // Extract scenes from current page
            const scenes = await page.evaluate((performerName) => {
                const scenes = [];
                const items = document.querySelectorAll('.list-videos .item');
                
                for (const item of items) {
                    const link = item.querySelector('a.thumb_img');
                    if (!link) continue;
                    
                    const href = link.href || link.getAttribute('href');
                    if (!href || !href.includes('/videos/')) continue;
                    
                    const titleEl = item.querySelector('.thumb_title, .title');
                    const img = item.querySelector('img.thumb');
                    const durationEl = item.querySelector('.duration');
                    const ratingEl = item.querySelector('.rating');
                    const viewsEl = item.querySelector('.views');
                    const studioEl = item.querySelector('.thumb_cs');
                    const has4k = !!item.querySelector('.k4, .icon-4k');
                    
                    const videoIdMatch = href.match(/\/videos\/[^\/]+\/(\d+)\//);
                    
                    scenes.push({
                        url: href,
                        videoId: videoIdMatch ? videoIdMatch[1] : null,
                        title: titleEl ? titleEl.textContent.trim() : 'Untitled Scene',
                        thumbnail: img ? (img.src || img.getAttribute('data-src') || '') : '',
                        duration: durationEl ? durationEl.textContent.trim().replace('Full Video', '').trim() : '',
                        rating: ratingEl ? parseFloat(ratingEl.textContent.trim()) : null,
                        views: viewsEl ? parseInt(viewsEl.textContent.trim().replace(/,/g, '')) : null,
                        studio: studioEl ? studioEl.textContent.trim() : null,
                        has4k: has4k
                    });
                }
                
                return scenes;
            }, performer.name);
            
            // Add only new scenes (avoid duplicates)
            let newScenes = 0;
            for (const scene of scenes) {
                if (!seenUrls.has(scene.url)) {
                    seenUrls.add(scene.url);
                    allScenes.push(scene);
                    newScenes++;
                }
            }
            
            console.log(`      Found ${scenes.length} scenes (${newScenes} new, ${scenes.length - newScenes} duplicates)`);
            
            // If no new scenes, we've likely reached the end
            if (newScenes === 0) {
                consecutiveEmptyPages++;
                if (consecutiveEmptyPages >= 2) {
                    console.log(`   📭 No new scenes for 2 pages, stopping`);
                    hasMore = false;
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
            }
            
            // Check for next page
            const hasNextPage = await page.evaluate(() => {
                const nextBtn = document.querySelector('.next:not(.no_link), .pagination-next:not(.disabled), a[rel="next"]:not(.disabled)');
                return nextBtn !== null;
            });
            
            if (!hasNextPage) {
                console.log(`   📭 No next page found`);
                hasMore = false;
                break;
            }
            
            // Go to next page
            try {
                const nextBtn = await page.$('.next:not(.no_link), .pagination-next:not(.disabled), a[rel="next"]:not(.disabled)');
                if (nextBtn) {
                    await nextBtn.click();
                    await page.waitForTimeout(1500);
                    currentPage++;
                } else {
                    hasMore = false;
                }
            } catch (error) {
                console.log(`   ⚠️ Could not navigate to next page: ${error.message}`);
                hasMore = false;
            }
            
        } catch (error) {
            console.log(`   ⚠️ Error on page ${currentPage}: ${error.message}`);
            retryCount++;
            if (retryCount >= MAX_RETRIES) {
                console.log(`   ❌ Max retries reached, stopping`);
                hasMore = false;
            } else {
                await page.waitForTimeout(3000);
            }
        }
    }
    
    console.log(`   📊 Total unique scenes found: ${allScenes.length}`);
    console.log(`   📄 Pages scraped: ${currentPage}`);
    return allScenes;
}

// =========================
// RELIABLE: EXTRACT 720p VIDEO WITH RETRY
// =========================
async function extractVideo720p(page, sceneUrl, retryCount = 0) {
    try {
        // Navigate to scene page
        await page.goto(sceneUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        
        await page.waitForTimeout(500);
        
        // Check for Cloudflare
        const content = await page.content();
        if (content.includes('cf-browser-verification') || 
            content.includes('Cloudflare') ||
            content.includes('Checking your browser')) {
            console.log(`      ⚠️ Cloudflare detected on scene page`);
            if (retryCount < MAX_RETRIES) {
                await page.waitForTimeout(5000);
                return await extractVideo720p(page, sceneUrl, retryCount + 1);
            }
            return { video720p: null, allQualities: [], error: 'Cloudflare blocked' };
        }
        
        // Extract video URL
        const videoData = await page.evaluate(() => {
            const data = {
                video720p: null,
                allQualities: []
            };
            
            const sources = document.querySelectorAll('video source, a[href*="get_file"]');
            let bestSource = null;
            let bestQuality = 0;
            
            for (const source of sources) {
                const src = source.src || source.href || source.getAttribute('src');
                if (!src || !src.includes('get_file')) continue;
                
                const qualityMatch = src.match(/_(\d+)p/);
                const quality = qualityMatch ? parseInt(qualityMatch[1]) : 0;
                
                data.allQualities.push(qualityMatch ? `${qualityMatch[1]}p` : 'unknown');
                
                // Prefer 720p, then highest quality
                if (quality === 720 || quality === 1080 || quality === 2160) {
                    if (!data.video720p || quality > bestQuality) {
                        data.video720p = src;
                        bestQuality = quality;
                    }
                }
            }
            
            // If no preferred quality found, take first source
            if (!data.video720p && sources.length > 0) {
                const firstSource = sources[0];
                data.video720p = firstSource.src || firstSource.href || firstSource.getAttribute('src');
            }
            
            return data;
        });
        
        return videoData;
        
    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            console.log(`      ⚠️ Retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
            await page.waitForTimeout(2000);
            return await extractVideo720p(page, sceneUrl, retryCount + 1);
        }
        return { video720p: null, allQualities: [], error: error.message };
    }
}

// =========================
// PROCESS PERFORMER WITH COMPLETE COVERAGE
// =========================
async function processPerformer(performer, browser) {
    console.log(`\n🔍 Processing: ${performer.name}`);
    console.log(`   Slug: ${performer.slug}`);
    
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });
    
    try {
        // STEP 1: Get ALL scene links
        const sceneLinks = await extractAllSceneLinks(page, performer);
        
        if (sceneLinks.length === 0) {
            console.log(`   ⚠️ No scenes found for ${performer.name}`);
            await page.close();
            await context.close();
            return {
                performer: performer,
                scenes: [],
                totalScenes: 0,
                videosFound: 0,
                videosMissing: 0,
                failedScenes: [],
                success: true
            };
        }
        
        console.log(`   🎬 Processing ${sceneLinks.length} scenes for videos...`);
        
        // STEP 2: Process ALL scenes with retry for failures
        const scenesWithVideo = [];
        let videoFoundCount = 0;
        let videoMissingCount = 0;
        const failedScenes = [];
        
        // Process in batches
        const batchSize = CONCURRENT_SCENES;
        for (let i = 0; i < sceneLinks.length; i += batchSize) {
            const batch = sceneLinks.slice(i, i + batchSize);
            console.log(`   📦 Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(sceneLinks.length / batchSize)} (${i + 1}-${Math.min(i + batchSize, sceneLinks.length)})`);
            
            // Process each scene in batch
            for (const scene of batch) {
                console.log(`      🎬 ${scene.title.substring(0, 50)}...`);
                
                try {
                    const videoData = await extractVideo720p(page, scene.url);
                    
                    if (videoData.video720p) {
                        videoFoundCount++;
                        console.log(`         ✅ 720p found`);
                    } else {
                        videoMissingCount++;
                        console.log(`         ⚠️ No 720p found (${videoData.error || 'Unknown reason'})`);
                        // Track failed scene for potential retry
                        failedScenes.push({
                            ...scene,
                            reason: videoData.error || 'No video found'
                        });
                    }
                    
                    scenesWithVideo.push({
                        ...scene,
                        video720p: videoData.video720p,
                        videoQualities: videoData.allQualities || []
                    });
                    
                    await page.waitForTimeout(DELAY_BETWEEN_REQUESTS);
                    
                } catch (error) {
                    console.log(`      ❌ Error: ${error.message}`);
                    videoMissingCount++;
                    failedScenes.push({
                        ...scene,
                        reason: error.message
                    });
                    scenesWithVideo.push({
                        ...scene,
                        video720p: null,
                        videoQualities: [],
                        error: error.message
                    });
                }
            }
            
            console.log(`      📊 Progress: ${videoFoundCount + videoMissingCount}/${sceneLinks.length} (${videoFoundCount} with 720p)`);
            
            // Save failed scenes after each batch
            saveFailedScenes({
                performer: performer.name,
                timestamp: new Date().toISOString(),
                scenes: failedScenes
            });
        }
        
        // STEP 3: Retry failed scenes
        if (failedScenes.length > 0) {
            console.log(`\n   🔄 Retrying ${failedScenes.length} failed scenes...`);
            
            const retryScenes = [...failedScenes];
            let retrySuccess = 0;
            
            for (const failedScene of retryScenes) {
                console.log(`      🔄 Retrying: ${failedScene.title.substring(0, 40)}...`);
                
                try {
                    const videoData = await extractVideo720p(page, failedScene.url);
                    
                    if (videoData.video720p) {
                        // Update the scene with the video
                        const sceneIndex = scenesWithVideo.findIndex(s => s.url === failedScene.url);
                        if (sceneIndex !== -1) {
                            scenesWithVideo[sceneIndex].video720p = videoData.video720p;
                            scenesWithVideo[sceneIndex].videoQualities = videoData.allQualities || [];
                            videoFoundCount++;
                            videoMissingCount--;
                            retrySuccess++;
                            console.log(`         ✅ 720p found on retry!`);
                        }
                    }
                    
                    await page.waitForTimeout(DELAY_BETWEEN_REQUESTS);
                    
                } catch (error) {
                    console.log(`         ❌ Retry failed: ${error.message}`);
                }
            }
            
            console.log(`   ✅ Retry success: ${retrySuccess}/${failedScenes.length}`);
            
            // Update failed scenes list (remove successfully retried)
            const stillFailed = failedScenes.filter(fs => {
                const scene = scenesWithVideo.find(s => s.url === fs.url);
                return !scene || !scene.video720p;
            });
            
            saveFailedScenes({
                performer: performer.name,
                timestamp: new Date().toISOString(),
                scenes: stillFailed
            });
        }
        
        console.log(`   📊 Final: ${videoFoundCount} with 720p, ${videoMissingCount} without`);
        console.log(`   📊 Total scenes processed: ${scenesWithVideo.length}`);
        
        await page.close();
        await context.close();
        
        return {
            performer: performer,
            scenes: scenesWithVideo,
            totalScenes: scenesWithVideo.length,
            videosFound: videoFoundCount,
            videosMissing: videoMissingCount,
            failedScenes: failedScenes.filter(fs => {
                const scene = scenesWithVideo.find(s => s.url === fs.url);
                return !scene || !scene.video720p;
            }),
            success: true
        };
        
    } catch (error) {
        console.log(`   ❌ Error processing ${performer.name}: ${error.message}`);
        await page.close();
        await context.close();
        return {
            performer: performer,
            scenes: [],
            totalScenes: 0,
            videosFound: 0,
            videosMissing: 0,
            failedScenes: [],
            success: false,
            error: error.message
        };
    }
}

// =========================
// MAIN FUNCTION
// =========================
async function main() {
    console.log('🚀 Starting RELIABLE WOW.XXX batch scraper...');
    console.log(`⏰ Started at: ${new Date().toISOString()}`);
    console.log(`🔄 Max retries: ${MAX_RETRIES}`);
    console.log(`📦 Batch size: ${CONCURRENT_SCENES}`);
    
    ensureDirectories();
    
    // Load performers
    let performers = loadPerformers();
    if (performers.length === 0) {
        console.log('❌ No performers found!');
        return;
    }
    
    // Filter if target performer specified
    if (TARGET_PERFORMER) {
        performers = performers.filter(p => 
            p.name.toLowerCase().includes(TARGET_PERFORMER.toLowerCase())
        );
        console.log(`🎯 Filtered to target performer: ${TARGET_PERFORMER}`);
        console.log(`📊 Found ${performers.length} matching performers`);
    } else {
        // For testing, limit to 3 performers
        console.log('⚠️ Running in test mode (first 3 performers only)');
        performers = performers.slice(0, 3);
        console.log(`📊 Processing ${performers.length} performers (test mode)`);
        console.log('   To process all, change the slice limit in the code');
    }
    
    if (performers.length === 0) {
        console.log('❌ No performers to process!');
        return;
    }
    
    // Load progress
    const progress = loadProgress();
    const startIndex = progress.lastIndex || 0;
    let allResults = [];
    
    // Launch browser
    console.log('\n🌐 Launching browser...');
    const browser = await chromium.launch({
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    });
    
    console.log(`\n📊 Processing ${performers.length} performers...\n`);
    
    const startTime = Date.now();
    
    for (let i = startIndex; i < performers.length; i++) {
        const performer = performers[i];
        const performerStartTime = Date.now();
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📹 ${i + 1}/${performers.length}: ${performer.name}`);
        console.log(`   ID: ${performer.id}`);
        console.log(`   StashDB scenes: ${performer.scene_count || 'N/A'}`);
        console.log(`${'='.repeat(60)}`);
        
        try {
            const result = await processPerformer(performer, browser);
            allResults.push(result);
            
            const performerTime = ((Date.now() - performerStartTime) / 1000).toFixed(1);
            console.log(`   ⏱️ Time: ${performerTime}s`);
            
            // Save progress
            progress.lastIndex = i + 1;
            progress.lastPerformer = performer.name;
            progress.totalProcessed = i + 1;
            progress.totalPerformers = performers.length;
            saveProgress(progress);
            
            // Save incremental results
            const tempData = {
                timestamp: new Date().toISOString(),
                processedCount: i + 1,
                totalCount: performers.length,
                elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
                results: allResults
            };
            fs.writeFileSync(WOW_DATA_FILE + '.tmp', JSON.stringify(tempData, null, 2));
            
            console.log(`   💾 Progress saved (${i + 1}/${performers.length})`);
            
        } catch (error) {
            console.log(`   ❌ Failed to process ${performer.name}: ${error.message}`);
            allResults.push({
                performer: performer,
                scenes: [],
                totalScenes: 0,
                videosFound: 0,
                videosMissing: 0,
                failedScenes: [],
                success: false,
                error: error.message
            });
        }
        
        // Delay between performers
        await new Promise(r => setTimeout(r, 1000));
    }
    
    // Close browser
    await browser.close();
    console.log('\n🔒 Browser closed');
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // =========================
    // SAVE FINAL RESULTS
    // =========================
    console.log('\n💾 Saving final results...');
    
    const finalData = {
        timestamp: new Date().toISOString(),
        totalTimeSeconds: totalTime,
        totalPerformers: performers.length,
        processedPerformers: allResults.length,
        successful: allResults.filter(r => r.success).length,
        failed: allResults.filter(r => !r.success).length,
        totalScenesFound: allResults.reduce((sum, r) => sum + (r.totalScenes || 0), 0),
        totalVideosFound: allResults.reduce((sum, r) => sum + (r.videosFound || 0), 0),
        totalVideosMissing: allResults.reduce((sum, r) => sum + (r.videosMissing || 0), 0),
        totalFailedScenes: allResults.reduce((sum, r) => sum + (r.failedScenes ? r.failedScenes.length : 0), 0),
        results: allResults,
        failedScenesSummary: allResults
            .filter(r => r.failedScenes && r.failedScenes.length > 0)
            .map(r => ({
                performer: r.performer.name,
                count: r.failedScenes.length,
                scenes: r.failedScenes.map(s => ({ title: s.title, url: s.url, reason: s.reason }))
            }))
    };
    
    fs.writeFileSync(WOW_DATA_FILE, JSON.stringify(finalData, null, 2));
    console.log(`✅ Results saved to: ${WOW_DATA_FILE}`);
    
    // =========================
    // DISPLAY SUMMARY
    // =========================
    console.log('\n📊 ===== FINAL SUMMARY =====');
    console.log(`⏱️ Total time: ${totalTime}s (${(totalTime / 60).toFixed(1)} min)`);
    console.log(`👤 Total performers: ${performers.length}`);
    console.log(`✅ Successfully processed: ${finalData.successful}`);
    console.log(`❌ Failed: ${finalData.failed}`);
    console.log(`🎬 Total scenes found: ${finalData.totalScenesFound}`);
    console.log(`📹 Videos with 720p: ${finalData.totalVideosFound}`);
    console.log(`⚠️ Videos without 720p: ${finalData.totalVideosMissing}`);
    console.log(`🔄 Failed scenes (retry needed): ${finalData.totalFailedScenes}`);
    
    // Show performers with failed scenes
    if (finalData.totalFailedScenes > 0) {
        console.log('\n🔄 Performers with failed scenes:');
        finalData.failedScenesSummary.forEach((f, i) => {
            console.log(`   ${i + 1}. ${f.performer}: ${f.count} scenes failed`);
        });
    }
    
    // Show top performers by scene count
    const sorted = allResults
        .filter(r => r.success)
        .sort((a, b) => (b.totalScenes || 0) - (a.totalScenes || 0));
    
    console.log('\n📊 Top performers by scene count:');
    sorted.slice(0, 5).forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.performer.name}: ${r.totalScenes} scenes (${r.videosFound || 0} with 720p)`);
    });
    
    console.log(`\n📁 Output file: ${WOW_DATA_FILE}`);
    console.log(`📁 Failed scenes file: ${FAILED_SCENES_FILE}`);
    console.log(`📁 Progress file: ${PROGRESS_FILE}`);
    console.log('\n🎉 Scraping complete!');
}

// =========================
// RUN
// =========================
main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});