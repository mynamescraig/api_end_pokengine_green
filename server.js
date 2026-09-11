const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 5173;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

const server = http.createServer((req, res) => {
  // Discord's proxy appends launch params to the URL (e.g.
  // "/?instance_id=...&channel_id=...&guild_id=...&frame_id=...&platform=desktop"),
  // so we compare against the pathname only, not the raw req.url, or every
  // request from inside Discord fails to match and falls through to 404.
  const pathname = url.parse(req.url).pathname;

  if (req.method === 'POST' && pathname === '/api/token') {
    return handleTokenExchange(req, res);
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveIndex(res);
  }
  if (req.method === 'GET' && pathname === '/bundle.js') {
    return serveBundle(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// The client ID isn't secret (Discord itself hands it to anyone who opens
// the Activity), but it's still sourced from the same env var as the
// secret rather than hardcoded, so the two never drift apart across
// environments. %%DISCORD_CLIENT_ID%% is a plain numeric snowflake with
// no characters that need escaping into a JS string literal.
function serveIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    const rendered = html.replace('%%DISCORD_CLIENT_ID%%', DISCORD_CLIENT_ID || '');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(rendered);
  });
}

// Built by `npm run build` (esbuild bundling client.js + the SDK into one
// browser-ready file) -- see package.json. Not committed; Railway's
// Nixpacks Node provider runs the build script automatically before
// `npm start`, same as any local `npm run build && npm start`.
function serveBundle(res) {
  fs.readFile(path.join(__dirname, 'bundle.js'), (err, contents) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('bundle.js missing -- did the build step run?');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(contents);
  });
}

// The one route where correctness matters: this is the only place the
// client secret is ever read, and it must never be echoed back to the
// caller or logged. Deliberately NOT sending redirect_uri to Discord's
// token endpoint -- unlike a classic browser-redirect OAuth flow, the
// `code` here came from discordSdk.commands.authorize() inside the
// Activity iframe, not a real HTTP redirect, and Discord's own reference
// implementation (discord/embedded-app-sdk-examples, discord-activity-
// starter/packages/server/src/app.ts) omits it for exactly that reason.
function handleTokenExchange(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', async () => {
    let code;
    try {
      ({ code } = JSON.parse(body || '{}'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing code' }));
      return;
    }
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      console.error('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET is not set.');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is not configured for Discord OAuth.' }));
      return;
    }

    try {
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
        }),
      });

      if (!tokenResponse.ok) {
        console.error('Discord token exchange failed:', tokenResponse.status, await tokenResponse.text());
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Token exchange with Discord failed.' }));
        return;
      }

      const { access_token } = await tokenResponse.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token }));
    } catch (err) {
      console.error('Token exchange error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});