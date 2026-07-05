// fetch-to-file.js
// Fetches female performers with >10 scenes and saves to JSON file
// Run with: node fetch-to-file.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// =========================
// LOAD .env FILE
// =========================
const envPath = path.join(__dirname, '.env');
console.log('🔍 Loading .env from:', envPath);

if (fs.existsSync(envPath)) {
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
    console.log('❌ .env file NOT found');
    process.exit(1);
}

// =========================
// CONFIGURATION
// =========================
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJkYzM3NDRjZC1iODMzLTQyZGUtYTU3MC01MmJkZjhhNjY5ZmMiLCJzdWIiOiJBUElLZXkiLCJpYXQiOjE3ODI0OTMzNTB9.AdQ8_M2uM5ru2mm1AwofW8rwnXq0V2NBqLdPV-soiZI';
const GRAPHQL_URL = 'https://stashdb.org/graphql';
const OUTPUT_FILE = path.join(__dirname, 'stashdb_data.json');

const HEADERS = {
    'Content-Type': 'application/json',
    'ApiKey': API_KEY
};

// =========================
// GRAPHQL FUNCTIONS
// =========================
async function gql(query, variables = {}) {
    try {
        const response = await axios.post(GRAPHQL_URL, {
            query,
            variables
        }, { headers: HEADERS });
        if (response.data.errors) {
            console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
            throw new Error('GraphQL Error');
        }
        return response.data.data;
    } catch (error) {
        if (error.response) {
            console.error('API Error:', error.response.status);
            console.error('Response:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

// =========================
// FETCH FEMALE PERFORMERS
// =========================
async function fetchFemalePerformers() {
    console.log('📊 Fetching female performers from StashDB...');
    
    let allPerformers = [];
    let page = 1;
    let hasMore = true;
    let emptyPageCount = 0;
    
    const query = `
    query AllPerformers($input: PerformerQueryInput!) {
        queryPerformers(input: $input) {
            count
            performers {
                id
                name
                gender
                age
                height
                scene_count
                country
                ethnicity
                aliases
                is_favorite
                birthdate {
                    date
                }
                images {
                    url
                }
            }
        }
    }`;
    
    while (hasMore) {
        console.log(`   📄 Fetching page ${page}...`);
        
        try {
            const data = await gql(query, {
                input: {
                    gender: 'FEMALE',
                    page: page,
                    per_page: 100,
                    sort: 'NAME',
                    direction: 'ASC'
                }
            });
            
            const result = data.queryPerformers;
            const performers = result?.performers || [];
            
            if (performers.length === 0) {
                emptyPageCount++;
                if (emptyPageCount >= 3) {
                    console.log(`      📭 No performers for 3 pages. Stopping.`);
                    hasMore = false;
                    break;
                }
                console.log(`      📭 Empty page ${page}, waiting...`);
                page++;
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            emptyPageCount = 0;
            
            // Filter out performers with 10 or fewer scenes
            const filteredPerformers = performers.filter(p => (p.scene_count || 0) > 10);
            
            const formattedPerformers = filteredPerformers.map(p => ({
                ...p,
                birthdate: p.birthdate?.date || null
            }));
            
            allPerformers = allPerformers.concat(formattedPerformers);
            
            const total = result?.count || 0;
            const filtered = filteredPerformers.length;
            const skipped = performers.length - filtered;
            
            console.log(`      ✅ ${filtered} performers (skipped ${skipped} with ≤10 scenes) (${allPerformers.length} total)`);
            
            if (allPerformers.length >= total) {
                hasMore = false;
            }
            
            page++;
            
        } catch (error) {
            console.error(`   ❌ Error on page ${page}:`, error.message);
            hasMore = false;
        }
    }
    
    console.log(`✅ Total female performers with >10 scenes: ${allPerformers.length}`);
    return allPerformers;
}

// =========================
// FETCH SCENES FOR A PERFORMER
// =========================
async function fetchPerformerScenes(performerId) {
    const query = `
    query PerformerScenes($input: SceneQueryInput!) {
        queryScenes(input: $input) {
            count
            scenes {
                id
                title
                date
                duration
                studio {
                    id
                    name
                }
                images {
                    url
                }
            }
        }
    }`;
    
    let allScenes = [];
    let page = 1;
    let hasMore = true;
    const MAX_PER_PAGE = 500;
    
    while (hasMore) {
        try {
            const data = await gql(query, {
                input: {
                    performers: {
                        value: performerId,
                        modifier: "INCLUDES"
                    },
                    page: page,
                    per_page: MAX_PER_PAGE,
                    sort: 'DATE',
                    direction: 'DESC'
                }
            });
            
            const scenes = data.queryScenes?.scenes || [];
            
            if (scenes.length === 0) {
                hasMore = false;
                break;
            }
            
            allScenes = allScenes.concat(scenes);
            
            const total = data.queryScenes?.count || 0;
            hasMore = allScenes.length < total;
            page++;
            
            if (scenes.length < MAX_PER_PAGE) {
                hasMore = false;
            }
            
        } catch (error) {
            console.error(`   ⚠️ Error fetching scenes:`, error.message);
            hasMore = false;
        }
    }
    
    return allScenes;
}

// =========================
// PROCESS PERFORMER
// =========================
async function processPerformer(performer, index, total) {
    console.log(`   🔄 [${index + 1}/${total}] ${performer.name} (${performer.scene_count} scenes)`);
    
    try {
        const scenes = await fetchPerformerScenes(performer.id);
        return {
            performer: performer,
            scenes: scenes
        };
    } catch (error) {
        console.error(`   ❌ Error fetching scenes for ${performer.name}:`, error.message);
        return {
            performer: performer,
            scenes: []
        };
    }
}

// =========================
// SAVE PROGRESS
// =========================
function saveProgress(data, performers, processed, total) {
    const progress = {
        timestamp: new Date().toISOString(),
        totalPerformers: total,
        processedPerformers: processed,
        performers: performers,
        data: data
    };
    
    fs.writeFileSync(OUTPUT_FILE + '.progress', JSON.stringify(progress, null, 2));
}

// =========================
// MAIN
// =========================
async function main() {
    console.log('🚀 Starting data fetch to file...\n');
    console.log(`📁 Output file: ${OUTPUT_FILE}`);
    console.log(`📁 Progress file: ${OUTPUT_FILE}.progress\n`);
    
    // Check for existing progress
    let performers = [];
    let allData = [];
    let startIndex = 0;
    
    if (fs.existsSync(OUTPUT_FILE + '.progress')) {
        try {
            const progress = JSON.parse(fs.readFileSync(OUTPUT_FILE + '.progress', 'utf8'));
            console.log(`📦 Found existing progress: ${progress.processedPerformers}/${progress.totalPerformers} performers processed`);
            performers = progress.performers;
            allData = progress.data || [];
            startIndex = progress.processedPerformers || 0;
        } catch (e) {
            console.log('⚠️ Could not read progress file, starting fresh...');
        }
    }
    
    // If no performers loaded, fetch them
    if (performers.length === 0) {
        performers = await fetchFemalePerformers();
        if (performers.length === 0) {
            console.log('❌ No performers found!');
            return;
        }
    }
    
    console.log(`\n📊 Processing ${performers.length} female performers with >10 scenes...\n`);
    console.log(`⏳ Starting from index ${startIndex}...\n`);
    
    const BATCH_SIZE = 5;
    
    for (let i = startIndex; i < performers.length; i += BATCH_SIZE) {
        const batch = performers.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(performers.length / BATCH_SIZE);
        
        console.log(`📦 Batch ${batchNum}/${totalBatches} (${i + 1}-${Math.min(i + BATCH_SIZE, performers.length)}/${performers.length})`);
        
        // Process batch in parallel
        const results = await Promise.all(
            batch.map((p, idx) => processPerformer(p, i + idx, performers.length))
        );
        
        allData = allData.concat(results);
        
        // Save progress
        saveProgress(allData, performers, i + BATCH_SIZE, performers.length);
        
        // Calculate total scenes
        const totalScenes = allData.reduce((sum, r) => sum + r.scenes.length, 0);
        console.log(`   💾 Saved ${results.length} performers, ${totalScenes} total scenes`);
        console.log(`   📊 Progress: ${i + BATCH_SIZE}/${performers.length} performers\n`);
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 1000));
    }
    
    // Final save
    const finalData = {
        timestamp: new Date().toISOString(),
        performers: performers,
        data: allData,
        totalPerformers: performers.length,
        totalScenes: allData.reduce((sum, r) => sum + r.scenes.length, 0)
    };
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalData, null, 2));
    console.log(`\n🎉 Data fetch complete!`);
    console.log(`📊 Total performers: ${performers.length}`);
    console.log(`📊 Total scenes: ${finalData.totalScenes}`);
    console.log(`📁 Saved to: ${OUTPUT_FILE}`);
    console.log(`📁 Size: ${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2)} MB`);
}

// =========================
// RUN
// =========================
main().catch(error => {
    console.error('❌ Fetch failed:', error.message);
    process.exit(1);
});