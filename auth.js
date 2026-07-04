// auth.js - Authentication module
const session = require('express-session');

// =========================
// CONFIGURATION
// =========================
const SITE_PASSWORD = 'your_password_here'; // CHANGE THIS!

// =========================
// SESSION SETUP
// =========================
function setupSession(app) {
    app.use(session({
        secret: 'your-secret-key-change-this-to-something-random',
        resave: false,
        saveUninitialized: false,
        cookie: { 
            secure: false,  // Set to true if using HTTPS
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    }));
}

// =========================
// AUTHENTICATION MIDDLEWARE
// =========================
function requireAuth(req, res, next) {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
}

// =========================
// LOGIN ROUTES
// =========================
function setupAuthRoutes(app) {
    // Login page
    app.get('/login', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <title>Login</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 0; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
                    .login-container { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 400px; width: 90%; border: 1px solid #2a2a2a; }
                    h1 { font-size: 28px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; display: inline-block; margin-bottom: 8px; }
                    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
                    .form-group { margin-bottom: 16px; }
                    label { display: block; color: #888; font-size: 13px; margin-bottom: 6px; }
                    input[type="password"] { width: 100%; padding: 12px 16px; border: 2px solid #333; border-radius: 12px; background: #111; color: #fff; font-size: 16px; transition: border-color 0.3s; }
                    input[type="password"]:focus { outline: none; border-color: #667eea; }
                    button { width: 100%; padding: 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; border-radius: 12px; color: #fff; font-weight: 600; font-size: 16px; cursor: pointer; transition: transform 0.2s, opacity 0.2s; }
                    button:hover { transform: scale(1.02); opacity: 0.9; }
                    .error { background: #2a1a1a; border: 1px solid #662222; color: #ff6b6b; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; display: none; }
                    footer { text-align: center; color: #444; font-size: 12px; margin-top: 16px; }
                </style>
            </head>
            <body>
                <div class="login-container">
                    <h1>🔒 Performer Viewer</h1>
                    <p class="subtitle">Enter the password to access the site</p>
                    <div id="errorMessage" class="error">❌ Incorrect password. Please try again.</div>
                    <form action="/login" method="POST" onsubmit="return validateForm(event)">
                        <div class="form-group">
                            <label for="password">Password</label>
                            <input type="password" id="password" name="password" placeholder="Enter password..." required autofocus>
                        </div>
                        <button type="submit">🔓 Unlock</button>
                    </form>
                    <footer>
                        <p>Protected site</p>
                    </footer>
                </div>
                <script>
                    function validateForm(event) {
                        var errorDiv = document.getElementById('errorMessage');
                        var password = document.getElementById('password').value;
                        if (!password || password.length < 1) {
                            errorDiv.style.display = 'block';
                            errorDiv.textContent = '❌ Please enter a password.';
                            event.preventDefault();
                            return false;
                        }
                        return true;
                    }
                    if (window.location.search.includes('error=1')) {
                        document.getElementById('errorMessage').style.display = 'block';
                    }
                </script>
            </body>
            </html>
        `);
    });

    // Login handler
    app.post('/login', (req, res) => {
        const password = req.body.password;
        if (password === SITE_PASSWORD) {
            req.session.authenticated = true;
            res.redirect('/');
        } else {
            res.redirect('/login?error=1');
        }
    });

    // Logout route
    app.get('/logout', (req, res) => {
        req.session.destroy();
        res.redirect('/login');
    });
}

module.exports = {
    setupSession,
    requireAuth,
    setupAuthRoutes,
    SITE_PASSWORD
};