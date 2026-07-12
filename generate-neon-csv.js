// generate-neon-csv.js
// Generates properly formatted CSV files for Neon import

const fs = require('fs');

// =========================
// PROPER CSV ESCAPING
// =========================
function escapeCSV(value) {
    // Handle null/undefined
    if (value === null || value === undefined || value === 'undefined' || value === 'null') {
        return '';
    }
    
    // Convert to string
    let str = String(value);
    
    // If it's literally "undefined" or "null", make it empty
    if (str === 'undefined' || str === 'null') {
        return '';
    }
    
    // Remove any carriage returns
    str = str.replace(/\r/g, '');
    
    // If it contains newlines, commas, or quotes, wrap in quotes
    if (str.includes('\n') || str.includes(',') || str.includes('"')) {
        // Escape existing quotes by doubling them
        str = str.replace(/"/g, '""');
        return `"${str}"`;
    }
    
    return str;
}

// =========================
// SAFE JSON STRINGIFY
// =========================
function safeJSON(data) {
    if (data === null || data === undefined) {
        return '[]';
    }
    try {
        return JSON.stringify(data);
    } catch (e) {
        return '[]';
    }
}

// =========================
// GENERATE PERFORMERS CSV
// =========================
function generatePerformersCSV() {
    console.log('📤 Generating performers.csv...');
    
    const stashData = JSON.parse(fs.readFileSync('stashdb_data.json', 'utf8'));
    let performerData = stashData.data || stashData.performers || stashData;
    
    // Headers - match table columns EXACTLY
    const headers = [
        'id',
        'name',
        'gender',
        'age',
        'height',
        'scene_count',
        'country',
        'ethnicity',
        'aliases',
        'is_favorite',
        'images'
    ];
    
    let csv = headers.join(',') + '\n';
    let count = 0;
    let errorCount = 0;
    
    for (const item of performerData) {
        const p = item.performer || item;
        if (!p || !p.id) continue;
        
        try {
            // Handle JSON fields carefully
            const aliases = safeJSON(p.aliases || []);
            const images = safeJSON((p.images || []).slice(0, 5)); // Limit to 5 images
            
            const row = [
                p.id || '',
                (p.name || 'Unknown').replace(/[,"\n\r]/g, ' '),
                p.gender || '',
                p.age !== undefined && p.age !== null && p.age !== '' ? p.age : '',
                p.height !== undefined && p.height !== null && p.height !== '' ? p.height : '',
                Array.isArray(item.scenes) ? item.scenes.length : 0,
                p.country || '',
                p.ethnicity || '',
                aliases,
                p.is_favorite ? 'true' : 'false',
                images
            ];
            
            csv += row.map(escapeCSV).join(',') + '\n';
            count++;
            
            if (count % 1000 === 0) {
                console.log(`   Processed ${count} performers...`);
            }
        } catch (error) {
            errorCount++;
            if (errorCount <= 5) {
                console.log(`   ⚠️ Error on performer ${p.id}: ${error.message}`);
            }
        }
    }
    
    fs.writeFileSync('performers.csv', csv);
    console.log(`✅ performers.csv created (${count} rows, ${errorCount} errors)`);
}

// =========================
// GENERATE SCENES CSV
// =========================
function generateScenesCSV() {
    console.log('\n📤 Generating scenes.csv...');
    
    const stashData = JSON.parse(fs.readFileSync('stashdb_data.json', 'utf8'));
    let performerData = stashData.data || stashData.performers || stashData;
    
    const headers = [
        'id',
        'title',
        'date',
        'duration',
        'studio_id',
        'studio_name',
        'images'
    ];
    
    let csv = headers.join(',') + '\n';
    const sceneMap = new Map();
    
    // Collect unique scenes
    for (const item of performerData) {
        if (Array.isArray(item.scenes)) {
            for (const scene of item.scenes) {
                if (scene && scene.id && !sceneMap.has(scene.id)) {
                    sceneMap.set(scene.id, scene);
                }
            }
        }
    }
    
    console.log(`   Found ${sceneMap.size} unique scenes`);
    let count = 0;
    let errorCount = 0;
    
    for (const scene of sceneMap.values()) {
        try {
            const images = safeJSON((scene.images || []).slice(0, 5)); // Limit to 5 images
            
            const row = [
                scene.id || '',
                (scene.title || 'Untitled').replace(/[,"\n\r]/g, ' '),
                scene.date || '',
                scene.duration !== undefined && scene.duration !== null ? scene.duration : 0,
                scene.studio ? scene.studio.id : '',
                scene.studio ? scene.studio.name : '',
                images
            ];
            
            csv += row.map(escapeCSV).join(',') + '\n';
            count++;
            
            if (count % 1000 === 0) {
                console.log(`   Processed ${count} scenes...`);
            }
        } catch (error) {
            errorCount++;
            if (errorCount <= 5) {
                console.log(`   ⚠️ Error on scene ${scene.id}: ${error.message}`);
            }
        }
    }
    
    fs.writeFileSync('scenes.csv', csv);
    console.log(`✅ scenes.csv created (${count} rows, ${errorCount} errors)`);
}

// =========================
// GENERATE PERFORMER_SCENES CSV
// =========================
function generateLinksCSV() {
    console.log('\n📤 Generating performer_scenes.csv...');
    
    const stashData = JSON.parse(fs.readFileSync('stashdb_data.json', 'utf8'));
    let performerData = stashData.data || stashData.performers || stashData;
    
    let csv = 'performer_id,scene_id\n';
    let count = 0;
    
    for (const item of performerData) {
        const p = item.performer || item;
        if (!p || !p.id) continue;
        if (!Array.isArray(item.scenes)) continue;
        
        for (const scene of item.scenes) {
            if (scene && scene.id) {
                csv += `${p.id},${scene.id}\n`;
                count++;
            }
        }
    }
    
    fs.writeFileSync('performer_scenes.csv', csv);
    console.log(`✅ performer_scenes.csv created (${count} rows)`);
}

// =========================
// GENERATE WOW_VIDEOS CSV
// =========================
function generateWowCSV() {
    console.log('\n📤 Generating wow_videos.csv...');
    
    try {
        const wowData = JSON.parse(fs.readFileSync('wow.xxx/data/wow_rss_data.json', 'utf8'));
        
        const headers = [
            'video_url',
            'performer_name',
            'title',
            'url',
            'thumbnail',
            'duration',
            'studio',
            'video720p',
            'all_qualities'
        ];
        
        let csv = headers.join(',') + '\n';
        let count = 0;
        let errorCount = 0;
        
        if (wowData.results) {
            for (const result of wowData.results) {
                const performerName = result.performer ? result.performer.name : 'Unknown';
                if (!Array.isArray(result.scenes)) continue;
                
                for (const scene of result.scenes) {
                    const videoUrl = scene.video720p || scene.url;
                    if (!videoUrl) continue;
                    
                    try {
                        const row = [
                            videoUrl,
                            performerName,
                            (scene.title || '').replace(/[,"\n\r]/g, ' '),
                            scene.url || '',
                            scene.thumbnail || '',
                            scene.duration || '',
                            scene.studio || '',
                            scene.video720p || '',
                            safeJSON(scene.allQualities || [])
                        ];
                        
                        csv += row.map(escapeCSV).join(',') + '\n';
                        count++;
                    } catch (error) {
                        errorCount++;
                        if (errorCount <= 5) {
                            console.log(`   ⚠️ Error on video: ${error.message}`);
                        }
                    }
                }
            }
        }
        
        fs.writeFileSync('wow_videos.csv', csv);
        console.log(`✅ wow_videos.csv created (${count} rows, ${errorCount} errors)`);
        
    } catch (error) {
        console.log('⚠️ Could not create wow_videos.csv:', error.message);
    }
}

// =========================
// RUN ALL
// =========================
console.log('🚀 Generating CSV files for Neon import...\n');
console.log('📋 This will create properly formatted CSV files.\n');

generatePerformersCSV();
generateScenesCSV();
generateLinksCSV();
generateWowCSV();

console.log('\n' + '='.repeat(50));
console.log('📊 All CSV files created!');
console.log('   📁 performers.csv');
console.log('   📁 scenes.csv');
console.log('   📁 performer_scenes.csv');
console.log('   📁 wow_videos.csv');
console.log('\n📤 IMPORT ORDER:');
console.log('   1. performers.csv');
console.log('   2. scenes.csv');
console.log('   3. performer_scenes.csv');
console.log('   4. wow_videos.csv');
console.log('\n💡 In Neon: Tables → Import → Select CSV → Map columns → Import');