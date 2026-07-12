// extract-json.js
const fs = require('fs');
const zlib = require('zlib');

// Read the base64 file
const base64Data = fs.readFileSync('wow_rss_data.json.gz.b64', 'utf8');

// Decode from base64
const compressedData = Buffer.from(base64Data, 'base64');

// Decompress the gzip data
const jsonData = zlib.gunzipSync(compressedData);

// Save to JSON file
fs.writeFileSync('wow_rss_data.json', jsonData);
console.log('✅ Extracted wow_rss_data.json');

// Verify the file size
const stats = fs.statSync('wow_rss_data.json');
console.log(`📊 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
