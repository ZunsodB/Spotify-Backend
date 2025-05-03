// get_refresh_token.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
// REMOVED: const open = require('open'); // This caused the error
const crypto = require('crypto');

const app = express();
const port = process.env.TEMP_PORT || 8888;
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.TEMP_REDIRECT_URI;
const scope = process.env.SPOTIFY_SCOPES;
const stateKey = 'spotify_auth_state'; // Key for potential future state storage (not strictly used here)

if (!clientId || !clientSecret || !redirectUri || !scope) {
    console.error("Error: Missing necessary environment variables in .env for this script (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, TEMP_REDIRECT_URI, SPOTIFY_SCOPES)");
    process.exit(1);
}

// Make the route handler async to use await for dynamic import
app.get('/login', async (req, res) => { // <--- Added async here
    const state = crypto.randomBytes(16).toString('hex');
    // In a real app, you'd use cookies/session for state, but for this script, generating is sufficient.
    console.log("Generated state:", state);

    const authUrl = 'https://accounts.spotify.com/authorize?' +
        new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: redirectUri,
            state: state,
            // show_dialog: 'true' // Uncomment to force login/permission screen every time
        }).toString();

    console.log("\nAttempting to open browser for Spotify authorization...");
    console.log("If the browser doesn't open, please copy and paste this URL into your browser:");
    console.log(authUrl + "\n");

    // Send response to browser first to show redirection message
    res.send(`<html><body><p>Redirecting you to Spotify to authorize...</p><script>window.location.href="${authUrl}";</script></body></html>`);

    // Dynamically import 'open' inside the async function AFTER sending response
    try {
        // Use dynamic import() which returns a promise
        const open = (await import('open')).default; // Get the default export
        await open(authUrl); // Use await as open might return a promise
        console.log("Browser open attempt finished.");
    } catch (err) {
         console.error("Failed to dynamically import or run 'open'. This might happen if the 'open' package isn't installed or due to permissions.", err);
         console.log("Please open the URL manually using the link logged above.");
    }
});

// Callback route needs to be async because it uses await for axios
app.get('/callback', async (req, res) => { // <--- Ensure this is async
    const code = req.query.code || null;
    const state = req.query.state || null;
    const error = req.query.error || null;

    console.log("\nReceived callback:");
    console.log("Code:", code ? code.substring(0, 10) + "..." : "Not received"); // Don't log full sensitive code
    console.log("State:", state);
    console.log("Error:", error);

    if (error) {
        console.error("Error received during Spotify callback:", error);
        return res.send(`<html><body><h1>Error during authorization</h1><p>${error}</p><p>Check the script console.</p></body></html>`);
    }

    // Basic state check (can be enhanced by storing state before redirect)
    if (state === null) {
         console.warn("Warning: State parameter missing in callback. This is a potential security risk if not intended.");
         // In a production app, you should strictly validate the state.
         // For this script's purpose, we might proceed cautiously or stop.
         // return res.status(400).send('<html><body><h1>Error</h1><p>State mismatch or missing.</p></body></html>');
    }

    if (!code) {
        return res.status(400).send('<html><body><h1>Error</h1><p>Authorization code not found in callback query parameters.</p></body></html>');
    }

    console.log("\nExchanging authorization code for tokens...");

    try {
        // Prepare credentials for Basic Auth header
        // Encodes "client_id:client_secret" to Base64
        const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const tokenResponse = await axios.post('https://accounts.spotify.com/api/token', new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            // client_id and client_secret are provided via the Authorization header below
        }).toString(), { // Send data as x-www-form-urlencoded string
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${authHeader}` // Basic Auth required
            }
        });

        const accessToken = tokenResponse.data.access_token;
        const refreshToken = tokenResponse.data.refresh_token;
        const expiresIn = tokenResponse.data.expires_in;

        if (!refreshToken) {
             console.error("\n--- ERROR ---");
             console.error("Did not receive a refresh token from Spotify.");
             console.error("This can happen if the user has previously authorized and you didn't use 'show_dialog=true', or if scopes haven't changed.");
             console.error("Try adding 'show_dialog: true' to the /login route's authUrl parameters and run again.");
             console.error("Or revoke app access in your Spotify account settings and retry.");
             console.error("---------------\n");
              res.status(500).send(`<html><body><h1>Error</h1><p>Did not receive a refresh token from Spotify. Check the script console.</p></body></html>`);
        } else {
            console.log("\n--- Success! ---");
            console.log("Access Token:", accessToken ? accessToken.substring(0, 10) + "..." : "N/A");
            console.log("Expires In:", expiresIn, "seconds");
            console.log("\n>>> REFRESH TOKEN (COPY THIS to your backend .env file as SPOTIFY_REFRESH_TOKEN):");
            // Print it clearly for easy copying
            console.log("------------------------------------------------------------------");
            console.log(`${refreshToken}`);
            console.log("------------------------------------------------------------------\n");

            res.send(`
                <html>
                    <head><title>Spotify Token Acquired</title></head>
                    <body style="font-family: sans-serif; padding: 20px;">
                        <h1>Success!</h1>
                        <p>Refresh token has been printed to the script's console.</p>
                        <p>You can now close this browser tab and stop the script (Ctrl+C in the terminal).</p>
                        <hr>
                        <p><strong>Your Refresh Token:</strong></p>
                        <p style="font-family: monospace; background: #eee; padding: 15px; word-break: break-all; border-radius: 5px; font-size: 1.1em;">
                            ${refreshToken}
                        </p>
                        <hr>
                        <p style="font-size: 0.8em; color: #555;">(Do not share this token)</p>
                    </body>
                </html>`);
        }

        // Optional: Stop the server automatically after success/failure
        server.close(() => {
             console.log('\nTemporary server stopped.');
             process.exit(refreshToken ? 0 : 1); // Exit with 0 on success, 1 on failure (no refresh token)
         });

    } catch (err) {
        console.error("\nError exchanging code for token:");
        if (err.response) {
            console.error("Spotify API Error Status:", err.response.status);
            console.error("Spotify API Error Data:", err.response.data);
        } else if (err.request) {
             console.error("No response received from Spotify token endpoint:", err.request);
        } else {
            console.error("Error setting up request:", err.message);
        }
        res.status(500).send(`<html><body><h1>Error Exchanging Token</h1><p>Failed to get tokens from Spotify. Check the script console for details.</p><p>${err.message}</p></body></html>`);

         // Optional: Stop the server on failure
         server.close(() => {
             console.log('\nTemporary server stopped due to error.');
             process.exit(1);
         });
    }
});

// --- Script Startup ---
console.log("\n--- Spotify Refresh Token Retriever ---");
console.log(`Temporary server listening on http://localhost:${port}`);
console.log(`Ensure the Redirect URI '${redirectUri}' is added to your allowed URIs in the Spotify Developer Dashboard.`);
console.log("\n>>> Step 1: Open your web browser and visit the following URL:");
console.log(`http://localhost:${port}/login`);
console.log("\n>>> Step 2: Log in with your 'sodo' Spotify account and authorize the application.");
console.log(">>> Step 3: The refresh token will be printed below once authorization is complete.\n");

// Start the server and store the server instance so we can close it later
const server = app.listen(port);

// Handle server errors (like port already in use)
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nError: Port ${port} is already in use. Please stop the other process or change TEMP_PORT in the .env file.\n`);
    } else {
         console.error('\nServer error:', err);
    }
    process.exit(1);
});