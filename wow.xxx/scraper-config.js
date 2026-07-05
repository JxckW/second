// scraper-config.js
// Configuration for the wow.xxx video scraper

const path = require('path');

module.exports = {
    // Target website
    baseUrl: 'https://www.wow.xxx',
    
    // Data storage paths (relative to this file)
    dataPaths: {
        scenes: path.join(__dirname, 'data', 'scenes'),
        performers: path.join(__dirname, 'data', 'performers'),
        videos: path.join(__dirname, 'data', 'videos'),
        jsonOutput: path.join(__dirname, 'wow_data.json')
    },
    
    // Selectors for different data types
    selectors: {
        // Video related
        videoElement: 'video',
        videoSource: 'video source',
        videoPlayer: 'iframe[src*="video"], iframe[src*="embed"], iframe[src*="player"]',
        videoLink: 'a[href*="get_file"], a[href*=".mp4"], a[href*=".m3u8"]',
        videoPoster: 'video[poster], img[class*="poster"]',
        
        // Performer related
        performerLink: 'a[href*="performer"], a[href*="model"], a[href*="actor"]',
        performerName: '.performer-name, .model-name, .actor-name, .performer a',
        performerList: '.performers, .models, .cast, .actors',
        
        // Studio related
        studioLink: 'a[href*="studio"], a[href*="brand"]',
        studioName: '.studio-name, .brand-name, .studio a',
        
        // Scene metadata
        sceneTitle: 'h1, .title, .scene-title, .video-title',
        sceneDate: '.date, .release-date, .published-date',
        sceneDuration: '.duration, .length, .runtime',
        sceneDescription: '.description, .synopsis, .details, .scene-description',
        sceneTags: '.tags a, .tag, .categories a',
        sceneRating: '.rating, .score, .votes',
        sceneViews: '.views, .view-count',
        
        // Navigation
        nextPage: '.next, .pagination-next, a[rel="next"]',
        loadMore: '.load-more, .show-more, .view-more',
        paginationContainer: '.pagination, .page-numbers'
    },
    
    // Timeouts (in milliseconds)
    timeouts: {
        pageLoad: 60000,
        elementWait: 10000,
        cloudflareWait: 30000,
        betweenRequests: 2000,
        retryDelay: 5000
    },
    
    // Browser settings
    browser: {
        headless: false,  // Set to true for production
        humanize: true,
        geoip: true,
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
            '--disable-features=BlockInsecurePrivateNetworkRequests',
            '--disable-site-isolation-trials',
            '--disable-gpu',
            '--no-sandbox'
        ]
    },
    
    // Rate limiting
    rateLimit: {
        maxConcurrent: 3,
        delayBetweenRequests: 2000,
        delayBetweenBatches: 5000
    },
    
    // Retry settings
    retry: {
        maxAttempts: 3,
        backoffMultiplier: 2,
        initialDelay: 2000
    }
};