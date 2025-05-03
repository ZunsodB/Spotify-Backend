// backend/server.js - Simplified Version
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

// --- Essential Environment Variables ---
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const PORT = process.env.PORT || 8000;
let spotifyRefreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

// Basic validation
if (!CLIENT_ID || !CLIENT_SECRET || !spotifyRefreshToken || !FRONTEND_URL) {
  console.error("FATAL ERROR: Missing required environment variables (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN, FRONTEND_URL).");
  process.exit(1);
}

// --- Global State ---
let spotifyAccessToken = ''; // Stores the current access token

// --- Express App Setup ---
const app = express();
app.use(cors({ origin: FRONTEND_URL })); // Allow requests from frontend
app.use(express.json()); // Parse JSON bodies

console.log(`[Info] Backend configured to allow requests from: ${FRONTEND_URL}`);

// --- Spotify Token Refresh Function ---
const refreshAccessToken = async () => {
  if (!spotifyRefreshToken) {
    console.error("[Refresh] Cannot refresh: No refresh token available.");
    return false;
  }
  console.log('[Refresh] Attempting to refresh Spotify token...');
  try {
    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await axios.post('https://accounts.spotify.com/api/token', new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: spotifyRefreshToken,
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`
      },
      timeout: 10000 // 10 second timeout
    });

    spotifyAccessToken = response.data.access_token;
    // Update refresh token if Spotify provides a new one
    if (response.data.refresh_token) {
      console.log("[Refresh] Received new refresh token from Spotify.");
      spotifyRefreshToken = response.data.refresh_token;
      // Note: New token is only stored in memory. Consider persisting if needed.
    }
    console.log('[Refresh] Token refreshed successfully.');
    return true;

  } catch (error) {
    spotifyAccessToken = ''; // Clear invalid token
    console.error('[Refresh] Error refreshing Spotify token:');
    if (error.response) {
      console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
      if (error.response.status === 400 && error.response.data?.error === 'invalid_grant') {
        console.error("FATAL REFRESH ERROR: Invalid Grant. Refresh Token may be expired or revoked. Obtain a new one.");
        spotifyRefreshToken = null; // Stop trying with bad token
      }
    } else {
      console.error(error.message);
    }
    return false;
  }
};

// --- Spotify API Proxy Route ---
// Using app.use to capture all requests starting with /api/spotify
app.use('/api/spotify', async (req, res) => {
  // Get the specific Spotify endpoint (part after /api/spotify)
  const spotifyEndpoint = req.path.startsWith('/') ? req.path.substring(1) : req.path;
  console.log(`[Proxy] ${req.method} /api/spotify/${spotifyEndpoint}`);

  // 1. Ensure we have an access token
  if (!spotifyAccessToken) {
    console.log('[Proxy] No token, attempting refresh...');
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      return res.status(503).json({ error: 'Service Unavailable', message: 'Failed to authenticate with Spotify.' });
    }
  }

  // 2. Construct Spotify API URL
  const query = new URLSearchParams(req.query).toString();
  const spotifyUrl = `https://api.spotify.com/v1/${spotifyEndpoint}${query ? '?' + query : ''}`;

  // 3. Make the request to Spotify
  try {
    const spotifyResponse = await axios({
      method: req.method,
      url: spotifyUrl,
      headers: {
        'Authorization': `Bearer ${spotifyAccessToken}`,
        // Forward Content-Type for POST/PUT etc.
        ...(req.headers['content-type'] && { 'Content-Type': req.headers['content-type'] }),
      },
      // Forward body if present
      ...(req.body && Object.keys(req.body).length > 0 && { data: req.body }),
      timeout: 15000 // 15 second timeout
    });

    // 4. Forward Spotify's response to client
    res.status(spotifyResponse.status).json(spotifyResponse.data);

  } catch (error) {
    console.error(`[Proxy] Error during Spotify request to ${spotifyUrl}:`);
    if (error.response) {
      const statusCode = error.response.status;
      console.error(`Spotify Error Status: ${statusCode}, Data: ${JSON.stringify(error.response.data)}`);

      // 5. Handle 401 Unauthorized (Token Expired) - Attempt ONE refresh and retry
      if (statusCode === 401) {
        console.log('[Proxy] Received 401 from Spotify. Attempting token refresh and retry...');
        spotifyAccessToken = ''; // Clear expired token
        const refreshed = await refreshAccessToken();
        if (refreshed && spotifyAccessToken) {
          console.log('[Proxy] Token refreshed. Retrying original request...');
          try {
            // Retry the request
            const retryResponse = await axios({
              method: req.method,
              url: spotifyUrl,
              headers: { 'Authorization': `Bearer ${spotifyAccessToken}`, /* other needed headers */ },
              data: req.body, // ensure body is included in retry if needed
              timeout: 15000
            });
            res.status(retryResponse.status).json(retryResponse.data); // Send retry success response
          } catch (retryError) {
            console.error('[Proxy] Error during request retry:');
            if (retryError.response) {
                console.error(`Retry Status: ${retryError.response.status}, Retry Data: ${JSON.stringify(retryError.response.data)}`);
                res.status(retryError.response.status).json(retryError.response.data); // Forward retry error
            } else {
                 console.error(retryError.message);
                 res.status(500).json({ error: 'Internal Server Error during retry' });
            }
          }
        } else {
          console.error('[Proxy] Failed to refresh token after 401.');
          res.status(503).json({ error: 'Service Unavailable', message: 'Failed to re-authenticate with Spotify.' });
        }
      } else {
        // Forward other Spotify errors (400, 403, 404, 5xx etc.)
        res.status(statusCode).json(error.response.data);
      }
    } else {
      // Network errors or request setup errors
      console.error(error.message);
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to communicate with Spotify.' });
    }
  }
});


// --- Initial Token Refresh & Server Start ---
console.log('\n[Startup] Attempting initial Spotify token refresh...');
refreshAccessToken().then(success => {
  if (success) {
    console.log("[Startup] Initial token obtained.");
  } else {
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.warn("!! [Startup] FAILED to obtain initial Spotify token.");
    console.warn("!! Backend might not work until a token is refreshed.");
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  }

  // Start the server
  app.listen(PORT, () => {
    console.log(`\n[Server] Backend proxy listening on port ${PORT}`);
  }).on('error', (err) => { // Handle server startup errors
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Server Error] Port ${PORT} is already in use.`);
    } else {
      console.error('\n[Server Error]', err);
    }
    process.exit(1);
  });

}).catch(startupError => {
  console.error("\n[Startup] FATAL error during initial refresh promise:", startupError);
  process.exit(1);
});