// fix-tables.js
// Run with: node fix-tables.js

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '.env');
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
}

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixTables() {
    console.log('🔧 Fixing tables with correct data types...');
    
    try {
        // Drop existing tables in correct order
        await db.query('DROP TABLE IF EXISTS performer_scenes CASCADE');
        await db.query('DROP TABLE IF EXISTS scenes_local CASCADE');
        await db.query('DROP TABLE IF EXISTS performers_local CASCADE');
        
        console.log('✅ Tables dropped');
        
        // Recreate performers_local
        await db.query(`
            CREATE TABLE performers_local (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                gender TEXT,
                age INTEGER,
                height INTEGER,
                scene_count INTEGER,
                country TEXT,
                ethnicity TEXT,
                aliases TEXT[],
                is_favorite BOOLEAN DEFAULT FALSE,
                images TEXT[],
                birthdate TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ performers_local created');
        
        // Recreate scenes_local with TEXT for date
        await db.query(`
            CREATE TABLE scenes_local (
                id TEXT PRIMARY KEY,
                title TEXT,
                date TEXT,
                duration INTEGER,
                studio_id TEXT,
                studio_name TEXT,
                images TEXT[],
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ scenes_local created (date is TEXT)');
        
        // Recreate performer_scenes
        await db.query(`
            CREATE TABLE performer_scenes (
                performer_id TEXT REFERENCES performers_local(id) ON DELETE CASCADE,
                scene_id TEXT REFERENCES scenes_local(id) ON DELETE CASCADE,
                PRIMARY KEY (performer_id, scene_id)
            )
        `);
        console.log('✅ performer_scenes created');
        
        // Create indexes
        await db.query('CREATE INDEX idx_performer_name ON performers_local(name)');
        await db.query('CREATE INDEX idx_performer_gender ON performers_local(gender)');
        await db.query('CREATE INDEX idx_scene_studio ON scenes_local(studio_name)');
        await db.query('CREATE INDEX idx_performer_scenes_performer ON performer_scenes(performer_id)');
        await db.query('CREATE INDEX idx_performer_scenes_scene ON performer_scenes(scene_id)');
        
        console.log('✅ Indexes created');
        console.log('\n🎉 Tables fixed! Now run sync-performers.js again.');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
    
    await db.end();
}

fixTables();