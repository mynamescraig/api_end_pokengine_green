const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5173;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// Green's own HTTP API, never its database directly -- see handlePartyLookup.
const GREEN_API_BASE_URL = process.env.GREEN_API_BASE_URL;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// Shown on the page. Tells a tester on mobile -- where there are no
// devtools -- whether the HTML they're looking at came from the current
// container or a cache holding something older.
const SERVER_BOOT = new Date().toISOString();

// index.html was updating on deploy while bundle.js stayed frozen on an
// old build -- the page's CSS was current but its JavaScript wasn't, so
// something between this server and the browser (Discord's own Activity
// proxy being the obvious suspect) was still serving the copy of
// /bundle.js it cached on the very first launch, from before the
// no-store header existed. Cache-Control can't fix an entry a cache
// already holds; a different URL can, because no cache has a copy of a
// URL it has never seen. Hashing the content rather than using the boot
// time means the URL only changes when the bundle actually changes, so
// ordinary restarts still get to reuse a warm cache.
const BUNDLE_VERSION = (() => {
  try {
    const contents = fs.readFileSync(path.join(__dirname, 'bundle.js'));
    return crypto.createHash('sha1').update(contents).digest('hex').slice(0, 8);
  } catch {
    // Built at deploy time, so it is normally on disk well before the
    // first request. If it somehow isn't, fall back to something that at
    // least changes per container instead of a constant.
    return Date.now().toString(36);
  }
})();

const server = http.createServer((req, res) => {
  // Discord's proxy appends launch params to the URL (e.g.
  // "/?instance_id=...&channel_id=...&guild_id=...&frame_id=...&platform=desktop"),
  // so we compare against the pathname only, not the raw req.url, or every
  // request from inside Discord fails to match and falls through to 404.
  // req.url is always relative (e.g. "/api/token?foo=bar"), so the WHATWG
  // URL constructor needs a base to parse against -- any base works,
  // since only .pathname is ever read from the result.
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'POST' && pathname === '/api/token') {
    return handleTokenExchange(req, res);
  }
  if (req.method === 'POST' && pathname === '/api/party') {
    return handlePartyLookup(req, res);
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
    const rendered = html
      .replace('%%DISCORD_CLIENT_ID%%', DISCORD_CLIENT_ID || '')
      .replace('%%SERVER_BOOT%%', SERVER_BOOT)
      .replace('%%BUNDLE_VERSION%%', BUNDLE_VERSION);
    // This is a POC iterating fast, not a static site -- an intermediate
    // cache (Discord's own Activity proxy included) holding onto a stale
    // index.html/bundle.js after a redeploy is a worse failure mode than
    // paying for a fetch every load. no-store, not just no-cache: no-cache
    // still permits a conditional GET that can be satisfied from cache.
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
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
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
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

// Looks up the logged-in player's party through Green's own HTTP API --
// never its MySQL database directly. Green's own README documents exactly
// one precedent for an external/different-language consumer (the Paper
// Minecraft plugin), and it goes through this same API rather than the
// database, specifically so access control (api/auth.py) and the
// trainer_id/account-linking resolution logic (db/trainer_links.py --
// linking repoints a Minecraft player's data to live under their Discord
// snowflake) stay owned in exactly one place. A raw SQL client here would
// have to reimplement that logic and would silently drift out of sync
// with Green's own schema as it evolves; going through the API means this
// service inherits fixes for free.
function handlePartyLookup(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', async () => {
    let accessToken;
    try {
      ({ access_token: accessToken } = JSON.parse(body || '{}'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!accessToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing access_token' }));
      return;
    }
    if (!GREEN_API_BASE_URL || !GREEN_API_TOKEN) {
      console.error('GREEN_API_BASE_URL / GREEN_API_TOKEN is not set.');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is not configured to reach the battle engine.' }));
      return;
    }

    try {
      // Never trust a client-supplied Discord id -- ask Discord itself
      // who this access_token actually belongs to. A forged/stale id in
      // the request body would otherwise let any caller request any
      // player's party.
      const meResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!meResponse.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not verify Discord identity.' }));
        return;
      }
      const { id: discordId } = await meResponse.json();

      // trainer_id IS the Discord snowflake for this id -- true for a
      // Discord-originated account, and also true after a Minecraft
      // player links their Discord (linking repoints their party to live
      // here, per Green's db/trainer_links.py). A player who has never
      // linked simply has no row, and Green's own get_party already
      // reports that as an empty party rather than an error, so nothing
      // extra is needed here for that case.
      const partyResponse = await fetch(`${GREEN_API_BASE_URL}/v1/trainers/${discordId}/party`, {
        headers: { Authorization: `Bearer ${GREEN_API_TOKEN}` },
      });
      if (!partyResponse.ok) {
        console.error('Green party lookup failed:', partyResponse.status, await partyResponse.text());
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Party lookup failed.' }));
        return;
      }
      const { members } = await partyResponse.json();
      // proper_name, not nickname -- the ask is species names, and an
      // egg slot's proper_name already comes back as "Egg" (Green masks
      // it at the API boundary), so no special-casing is needed here.
      const party = (members || []).map((member) => member.proper_name);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ party }));
    } catch (err) {
      console.error('Party lookup error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});