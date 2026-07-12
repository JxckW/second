// extract-scene-urls.js
// Run: node extract-scene-urls.js

const fs = require('fs');

// Load your scraped data
const data = JSON.parse(fs.readFileSync('wow_rss_data.json', 'utf8'));

// Collect all unique scene URLs
const urlSet = new Set();

for (const result of data.results) {
    for (const scene of result.scenes || []) {
        if (scene.url) {
            urlSet.add(scene.url);
        }
    }
}

// Convert to array
const urls = Array.from(urlSet);
console.log(`📊 Extracted ${urls.length} unique scene URLs`);

// Create CSV with just URLs
let csv = 'scene_url\n';
for (const url of urls) {
    csv += `"${url.replace(/"/g, '""')}"\n`;
}

// Save CSV
const outputFile = 'scene_urls.csv';
fs.writeFileSync(outputFile, csv);
console.log(`✅ Saved to: ${outputFile}`);