// bulk-import.js
// Run with: node bulk-import.js

const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');

// =========================
// CONFIGURATION
// =========================
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJkYzM3NDRjZC1iODMzLTQyZGUtYTU3MC01MmJkZjhhNjY5ZmMiLCJzdWIiOiJBUElLZXkiLCJpYXQiOjE3ODI0OTMzNTB9.AdQ8_M2uM5ru2mm1AwofW8rwnXq0V2NBqLdPV-soiZI';
const GRAPHQL_URL = 'https://stashdb.org/graphql';
const DB_FILE = path.join(__dirname, 'user_data.db');

const HEADERS = {
    'Content-Type': 'application/json',
    'ApiKey': API_KEY
};

// Valid tiers
const VALID_TIERS = ['S', 'A', 'B', 'C', 'D', 'F', 'U', 'L'];

// =========================
// READLINE FOR USER INPUT
// =========================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// =========================
// INPUT DATA - PASTE YOUR LISTS HERE
// =========================

// Paste your performer names here (one per line, using backticks)
const performerNames = `
Kimmy Kimm
Piper Perri
Scarlett Sage
Dakota Skye
Morgan Lee
Gina Valentina
Kristen Scott
Natalie Brooks
Chloe Foster
Rebel Lynn
Riley Reid
Naomi Swann
Eveline Dellai
Kristy Black
Vanessa Sky
Emma Starletto
Baby Nicols
Marina Angel
Clara Mia
Kylie Rocket
Apolonia Lapiedra
Angel Windell
Clemence Audiard
Scarlet Skies
Suzy Rainbow
Tiffany Tatum
Emily Willis
Jia Lissa
Mona Blue
Lola Reve
Alexis Tae
Alexis Crystal
Mary Rock
Ana Rose
Alexis Brill
Coco Kiss
Anya Krey
Angelika Grays
Bianca Bangs
Mary Jane
Alex Little
Lulu Chu
Ellie Shou
Melanie Masters
Ria Rodriguez
Ayuri Sonoda
Kenzie Reeves
Coco Lovelock
Aria Banks
Summer Col
Alyssa Hart
Milana Milka
Kandy Kors
Jennifer Bliss
Bambi Brooks
Kokoro Wato
Vanessa Vox
Alisa Ford
Megumi Shinozaki
Sara Luvv
Alona Bloom
Fae Love
Mika Kim
Kiki Cali
Avery Black
Demi Hawks
Kaitlyn Katsaros
Geisha Kyd
Hazel Paige
Sydnee Taylor
Yasmeena Ali
Loren Strawberry
Cora Ora
Tamra Milan
Melisa Black
Leana Lovings
Layla Cherrie
Lola Foxx
Aften Opal
Kriss Kiss
Maya Bijou
Kate Quinn
Isabella Nice
Clara Trinity
Selma Sins
Lia Ponce
Jessie Parker
Mell's Blanco
Cecilia Lion
Mina Luxx
Valerie White
Esperanza Del Horno
Bailey Base
Andrea Kelly
Anna Kovachenko
Sage Fox
Brianna Arson
Natasha Ty
Ruby Rayes
Vanessa Marie
Bambi Dee
Gracie Green
Kitt Lacey
Binky Beaz
Keilani Kita
Luna Leve
Kitty Cam
Trinity Rae
Madison Hart
Minnie Scarlet
Jamie LaMore
Vanessa Sixxx
Nicole Auclair
Jenna Clove
Dragon Fruit
Anya Shidlerova
Daisy Chainz
Taylor Madison
Laura Angelina
Taylor Kush
Tinah Star
Jane Wilde
Liv Revamped
Aria Valencia
Venus Vixen
Skylar Green
Alice Thunder
Sasha Hall
Katerina Deville
Caprice Capone
Delilah Dagger
Alana Rose
Ava Haze
Amber S
Laura Garcia
Jynx Maze
Veronica Rodriguez
Serina Gomez
Myra Moans
Theodora Day
Lucy Mendez
Sarah Lace
Taylor Dare
Rita Jalace
Monika May
Natasha Malkova
Eva Sedona
Evelyn Rosa
Riley Shae
Heather Night
Dania Vega
Cora Moth
Night A
Jessie Volt
Paris White
Summer Vixen
Charly Summer
Scarlit Scandal
Penelope Reed
Lily Jordan
Sofie Reyez
Natalie Knight
Rina Ellis
Yhivi Kim
Anna Belle
Cali Caliente
Lya Missy
Jenna Reid
Daizy Cooper
Mia Moore
Pamela Morrison
Maya Rush
Sandra Wellness
Paisley Paige
Lily Fatale
Adrianna Jade
Nikki Bell
Naomi Nash
Kelsey Kage
Courtney Loxx
Bonnie Grey
Lizzie Bell
Lana Lovelace
Hayden Hennessy
Rita Akira
Alexis Tyler
Elizabeth Evans
Rita Sinclair
Viola Weber
Jessyka Swan
Izzi Ryder
Violet Moore
Holly Banks
Jade Jadore
Raquel Roper
AJ Applegate
Khloe Kapri
Laney Grey
Alison Rey
Candee Licious
Chanel Camryn
Lola Rae
Carolina Sweets
Daisy Haze
Marina Gold
Gia Paige
Aubree Valentine
Mischa Brooks
Alexa Flexy
Alyssa Bounty
Sydney Cole
Keira Croft
Destiny Cruz
Bella Rose
Amara Romani
Alina West
Ginebra Bellucci
Moka Mora
Serena Santos
Alex Grey
Foxy Di
Bonnie Dolce
Cassie Laine
Kiera Winters
Luna Lovely
Pressley Carter
Haley Sweet
`;

// Paste your tiers here (one per line, using backticks)
const performerTiers = `
C
B
B
C
B
S
A
B
A
A
D
B
C
A
D
C
A
S
A
S
B
B
D
C
B
A
A
D
A
S
A
C
B
S
C
B
C
A
C
C
A
A
C
U
U
U
S
B
C
C
U
U
U
A
B
U
D
U
U
S
D
A
U
U
A
B
A
S
B
U
B
L
U
D
U
B
U
C
S
B
S
A
B
S
C
B
L
U
S
S
U
S
S
C
S
B
C
U
B
A
A
A
U
B
B
C
U
S
B
U
U
U
S
U
U
U
C
U
U
U
U
B
B
S
B
S
D
U
C
U
S
D
B
U
U
A
S
D
D
A
B
A
U
U
U
U
B
U
C
U
B
U
U
A
A
S
S
A
C
S
S
S
B
U
L
B
A
B
B
B
S
U
S
B
U
U
U
U
B
U
F
B
U
C
U
U
L
U
C
L
U
B
U
L
U
D
B
D
B
C
B
U
S
U
B
B
B
C
B
S
S
C
A
S
B
B
A
S
C
S
S
B
L
S
S
U
C
`;

// =========================
// DATABASE FUNCTIONS
// =========================

function getDb() {
    return new sqlite3.Database(DB_FILE);
}

function saveRating(performerId, rating) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            `INSERT OR REPLACE INTO performer_ratings (performer_id, rating, updated_at) 
             VALUES (?, ?, CURRENT_TIMESTAMP)`,
            [performerId, rating],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function getExistingRatings() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all('SELECT performer_id, rating FROM performer_ratings', (err, rows) => {
            db.close();
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// =========================
// GRAPHQL FUNCTIONS
// =========================

async function gql(query, variables = {}) {
    try {
        const response = await axios.post(GRAPHQL_URL, {
            query,
            variables
        }, {
            headers: HEADERS
        });

        if (response.data.errors) {
            console.error('GraphQL Errors:', response.data.errors);
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

async function searchPerformers(term) {
    const query = `
    query SearchPerformer($term: String!) {
        searchPerformer(term: $term) {
            id
            name
            gender
            scene_count
        }
    }`;

    const data = await gql(query, { term: term });
    return data.searchPerformer || [];
}

// =========================
// PARSE MULTI-LINE INPUT
// =========================

function parseMultiLine(text) {
    return text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('//') && !line.startsWith('*'));
}

// =========================
// MAIN IMPORT FUNCTION
// =========================

async function bulkImport() {
    console.log('🚀 Starting bulk import...');
    console.log('📋 Valid tiers: S, A, B, C, D, F, U, L\n');
    
    // Parse the multi-line input
    const names = parseMultiLine(performerNames);
    const tiers = parseMultiLine(performerTiers);
    
    console.log(`📊 Found ${names.length} performers and ${tiers.length} tiers`);
    
    // Build the performer list
    const performers = [];
    const count = Math.min(names.length, tiers.length);
    
    for (let i = 0; i < count; i++) {
        const name = names[i];
        const tier = tiers[i].toUpperCase();
        
        if (!VALID_TIERS.includes(tier)) {
            console.log(`⚠️ Skipping "${name}" - invalid tier "${tier}"`);
            continue;
        }
        
        performers.push({ name, tier });
    }
    
    if (performers.length === 0) {
        console.log('❌ No valid performers found');
        rl.close();
        process.exit(1);
    }
    
    console.log(`✅ Valid performers: ${performers.length}\n`);
    
    // Check for mismatch
    if (names.length !== tiers.length) {
        console.log(`⚠️ Warning: ${names.length} names but ${tiers.length} tiers`);
        console.log(`   Only processing the first ${count} matches\n`);
    }
    
    // Get existing ratings to avoid duplicates
    const existing = await getExistingRatings();
    const existingIds = new Set(existing.map(r => r.performer_id));
    
    let imported = 0;
    let skipped = 0;
    let notFound = 0;
    
    // Process each performer
    for (const performer of performers) {
        console.log(`🔍 Searching for: "${performer.name}" (tier: ${performer.tier})`);
        
        try {
            const results = await searchPerformers(performer.name);
            
            if (results.length === 0) {
                console.log(`   ❌ No matches found\n`);
                notFound++;
                continue;
            }
            
            // Check for exact match first
            const exactMatch = results.find(r => r.name.toLowerCase() === performer.name.toLowerCase());
            let selectedResult = null;
            
            if (results.length === 1) {
                selectedResult = results[0];
                console.log(`   ✅ Found: ${selectedResult.name} (${selectedResult.gender || 'N/A'}, ${selectedResult.scene_count || 0} scenes)`);
            } else if (exactMatch) {
                selectedResult = exactMatch;
                console.log(`   ✅ Found exact match: ${selectedResult.name} (${selectedResult.gender || 'N/A'}, ${selectedResult.scene_count || 0} scenes)`);
                console.log(`   ⚠️ Note: ${results.length - 1} other matches exist`);
            } else {
                console.log(`   ⚠️ Multiple matches found:`);
                results.forEach((r, idx) => {
                    console.log(`      ${idx + 1}. ${r.name} (${r.gender || 'N/A'}, ${r.scene_count || 0} scenes)`);
                });
                
                const answer = await askQuestion(`   Select a match (1-${results.length}, or 's' to skip): `);
                
                if (answer.toLowerCase() === 's') {
                    console.log(`   ⏭️ Skipped by user\n`);
                    skipped++;
                    continue;
                }
                
                const choice = parseInt(answer);
                if (isNaN(choice) || choice < 1 || choice > results.length) {
                    console.log(`   ❌ Invalid choice. Skipping.\n`);
                    skipped++;
                    continue;
                }
                
                selectedResult = results[choice - 1];
                console.log(`   ✅ Selected: ${selectedResult.name}`);
            }
            
            if (selectedResult) {
                if (existingIds.has(selectedResult.id)) {
                    console.log(`   ⏭️ Already rated: ${selectedResult.name} - skipping\n`);
                    skipped++;
                } else {
                    await saveRating(selectedResult.id, performer.tier);
                    console.log(`   ✅ Saved: ${selectedResult.name} → ${performer.tier}\n`);
                    imported++;
                    existingIds.add(selectedResult.id);
                }
            }
            
        } catch (error) {
            console.log(`   ❌ Error: ${performer.name} - ${error.message}\n`);
            notFound++;
        }
    }
    
    console.log('\n📊 ===== IMPORT SUMMARY =====');
    console.log(`✅ Imported: ${imported}`);
    console.log(`⏭️ Skipped (already rated): ${skipped}`);
    console.log(`❌ Not found or error: ${notFound}`);
    console.log(`📦 Total processed: ${performers.length}`);
    console.log('\n🎉 Import complete!');
    
    rl.close();
}

// =========================
// RUN THE IMPORT
// =========================

bulkImport().catch(error => {
    console.error('❌ Import failed:', error.message);
    rl.close();
    process.exit(1);
});