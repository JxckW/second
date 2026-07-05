// data-loader.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIGURATION
// =========================
// REPLACE THESE URLs WITH YOUR GOOGLE DRIVE OR DROPBOX LINKS
const DATA_URLS = {
    stashdb: 'https://drive.google.com/file/d/171gkUM20uL3nr_e5UzXiasyhxf3dQsZp/view?usp=sharing',
    wowData: 'https://drive.google.com/file/d/1_3rI2aWZNOxqooRoAqEZ0e9tMYpa04Ee/view?usp=sharing'
};

const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =========================
// FETCH DATA FROM URL OR LOCAL
// =========================
async function fetchData(url, filename) {
    const localPath = path.join(DATA_DIR, filename);
    
    // Try local file first
    if (fs.existsSync(localPath)) {
        try {
            console.log(`📂 Loading ${filename} from local cache...`);
            const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            console.log(`✅ ${filename} loaded from cache`);
            return data;
        } catch (error) {
            console.log(`⚠️ Local ${filename} is corrupt, downloading...`);
        }
    }
    
    // Download from URL
    console.log(`📡 Downloading ${filename} from URL...`);
    try {
        const response = await axios.get(url, {
            timeout: 120000, // 2 minutes for large files
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        // Save locally for next time
        fs.writeFileSync(localPath, JSON.stringify(response.data, null, 2));
        console.log(`💾 ${filename} saved to local cache (${(response.data.length / 1024 / 1024).toFixed(1)} MB)`);
        
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to download ${filename}: ${error.message}`);
        return null;
    }
}

module.exports = { fetchData, DATA_URLS };