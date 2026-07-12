// recreate-wow-videos.js
const { Pool } = require('pg');

const NEON_CONNECTION = 'postgresql://neondb_owner:npg_obO5yXkjs4aS@ep-holy-union-at9glfeu-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const neonPool = new Pool({
    connectionString: NEON_CONNECTION
});

async function recreateTable() {
    console.log('📂 Recreating wow_videos table...');
    
    try {
        // Drop and recreate
        await neonPool.query('DROP TABLE IF EXISTS wow_videos');
        console.log('🗑️ Dropped old table');
        
        await neonPool.query(`
            CREATE TABLE wow_videos (
                video_url TEXT PRIMARY KEY,
                performer_name TEXT,
                title TEXT,
                url TEXT,
                thumbnail TEXT,
                duration TEXT,
                studio TEXT,
                video720p TEXT,
                all_qualities TEXT
            )
        `);
        console.log('✅ Recreated table with correct structure');

        console.log('\n🎉 Table ready! Run the upload script now.');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await neonPool.end();
        console.log('🔒 Database connection closed');
    }
}

recreateTable();