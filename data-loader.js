// data-loader.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// =========================
// CONFIGURATION - REPLACE WITH YOUR GOOGLE DRIVE URLs
// =========================
const DATA_URLS = {
    stashdb: 'https://drive.google.com/uc?export=download&id=171gkUM20uL3nr_e5UzXiasyhxf3dQsZp&confirm=t',
    wowData: 'https://drive.google.com/uc?export=download&id=1_3rI2aWZNOxqooRoAqEZ0e9tMYpa04Ee&confirm=t'
};

const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Created data directory');
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
            const sizeMB = (fs.statSync(localPath).size / 1024 / 1024).toFixed(1);
            console.log(`✅ ${filename} loaded from cache (${sizeMB} MB)`);
            return data;
        } catch (error) {
            console.log(`⚠️ Local ${filename} is corrupt, downloading...`);
        }
    }
    
    // Download from URL
    console.log(`📡 Downloading ${filename} from URL...`);
    try {
        const response = await axios.get(url, {
            timeout: 180000, // 3 minutes for large files
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        // Save locally for next time
        fs.writeFileSync(localPath, JSON.stringify(response.data, null, 2));
        const sizeMB = (fs.statSync(localPath).size / 1024 / 1024).toFixed(1);
        console.log(`💾 ${filename} saved to local cache (${sizeMB} MB)`);
        
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to download ${filename}: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
        }
        return null;
    }
}

module.exports = { fetchData, DATA_URLS };