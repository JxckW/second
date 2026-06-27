const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
console.log('🔍 Checking .env file at:', envPath);
console.log('🔍 File exists?', fs.existsSync(envPath));

if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    console.log('🔍 File content preview:');
    console.log(content.substring(0, 100) + '...');
}

console.log('🔍 Current directory:', __dirname);