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

// Node's fetch has no default timeout, and a hung outbound call is
// indistinguishable, from the outside, from this server being broken:
// the handler never responds, Railway's gateway eventually gives up, and
// what the Activity receives is a Cloudflare "502 Bad gateway" naming
// this host -- with nothing in it about which call stalled or why. These
// caps mean this server always answers something it chose to say.
const DISCORD_TIMEOUT_MS = 10_000;
const ENGINE_TIMEOUT_MS = 15_000;

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

  // Deliberately the one route that touches nothing external: if a
  // platform healthcheck is pointed at this service and gets a 404, the
  // deploy is marked unhealthy and the container is cycled -- which from
  // the outside looks exactly like the intermittent "502 Bad gateway"
  // this service was returning, on requests that never reached any
  // handler. Answering here costs nothing and removes that explanation.
  if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
    return sendJson(res, 200, { status: 'ok', booted: SERVER_BOOT });
  }

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

    // Never trust a client-supplied Discord id -- ask Discord itself who
    // this access_token actually belongs to. A forged/stale id in the
    // request body would otherwise let any caller request any player's
    // party.
    //
    // Each outbound call gets its own try/catch, rather than one block
    // around the lot: a single catch-all reported "Internal server error"
    // for two completely different failures (Discord unreachable vs the
    // battle engine unreachable) and named neither, which is exactly what
    // made this take three rounds of screenshots to pin down.
    let discordId;
    const discordStartedAt = Date.now();
    try {
      const meResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
      if (!meResponse.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not verify Discord identity.' }));
        return;
      }
      ({ id: discordId } = await meResponse.json());
      console.log(`Discord identity resolved in ${Date.now() - discordStartedAt}ms`);
    } catch (err) {
      const timedOut = err && err.name === 'TimeoutError';
      console.error(
        `Discord identity lookup ${timedOut ? 'timed out' : 'failed'} after ` +
          `${Date.now() - discordStartedAt}ms:`,
        err
      );
      sendJson(res, timedOut ? 504 : 502, {
        error: timedOut
          ? `Discord did not respond within ${DISCORD_TIMEOUT_MS}ms.`
          : 'Could not reach Discord to verify identity.',
        detail: describeError(err),
      });
      return;
    }

    // trainer_id IS the Discord snowflake for this id -- true for a
    // Discord-originated account, and also true after a Minecraft player
    // links their Discord (linking repoints their party to live here, per
    // Green's db/trainer_links.py). A player who has never linked simply
    // has no row, and Green's own get_party already reports that as an
    // empty party rather than an error, so nothing extra is needed here
    // for that case.
    const partyUrl = `${GREEN_API_BASE_URL}/v1/trainers/${discordId}/party`;
    let partyResponse;
    const engineStartedAt = Date.now();
    try {
      partyResponse = await fetch(partyUrl, {
        headers: { Authorization: `Bearer ${GREEN_API_TOKEN}` },
        signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      });
      console.log(
        `Battle engine answered ${partyResponse.status} in ${Date.now() - engineStartedAt}ms`
      );
    } catch (err) {
      // Either never reached the engine at all -- a bad URL (a
      // GREEN_API_BASE_URL missing its scheme is the classic one), DNS,
      // TLS, nothing listening -- or reached it and waited past the cap,
      // which is what an accepted-but-unanswered connection looks like.
      const timedOut = err && err.name === 'TimeoutError';
      console.error(
        `Battle engine request ${timedOut ? 'timed out' : 'failed'} after ` +
          `${Date.now() - engineStartedAt}ms:`,
        partyUrl,
        err
      );
      sendJson(res, timedOut ? 504 : 502, {
        error: timedOut
          ? `The battle engine did not respond within ${ENGINE_TIMEOUT_MS}ms.`
          : 'Could not reach the battle engine.',
        detail: describeError(err),
      });
      return;
    }

    let rawBody;
    try {
      rawBody = await partyResponse.text();
    } catch (err) {
      // Reading the body can fail on its own (a connection dropped
      // mid-response). Left unguarded this rejects inside an async event
      // callback, which Node treats as an unhandled rejection and exits
      // the process for -- taking the whole service down over one bad
      // request, and surfacing as an opaque 502 from Discord's proxy
      // rather than anything this server ever gets to say.
      console.error('Could not read the battle engine response body:', err);
      sendJson(res, 502, {
        error: 'The battle engine response could not be read.',
        detail: describeError(err),
      });
      return;
    }

    if (!partyResponse.ok) {
      console.error('Battle engine rejected the party lookup:', partyResponse.status, rawBody);
      sendJson(res, 502, {
        error: 'The battle engine rejected the party lookup.',
        status: partyResponse.status,
        detail: rawBody.slice(0, 200),
      });
      return;
    }

    try {
      const { members } = JSON.parse(rawBody);
      // proper_name, not nickname -- the ask is species names, and an egg
      // slot's proper_name already comes back as "Egg" (Green masks it at
      // the API boundary), so no special-casing is needed here.
      const party = (members || []).map((member) => member.proper_name);
      sendJson(res, 200, { party });
    } catch (err) {
      console.error('Could not parse the battle engine response:', err, rawBody.slice(0, 200));
      sendJson(res, 502, {
        error: 'The battle engine returned something unreadable.',
        detail: describeError(err),
      });
    }
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A failed fetch in Node says only "fetch failed" -- the part that
 * actually identifies the problem (ENOTFOUND, ECONNREFUSED, a TLS
 * complaint) hangs off err.cause, so both go in.
 *
 * This ends up in the response body, which is a POC-time tradeoff made
 * deliberately: the Activity is being debugged on a phone with no
 * devtools, and a generic "Internal server error" is what cost us
 * several rounds of guessing. It can reveal the engine's hostname to
 * anyone who opens the Activity, so it should become log-only before
 * this is anything more than a proof of concept.
 */
function describeError(err) {
  if (!err) {
    return 'unknown error';
  }
  const cause = err.cause && err.cause.message ? ` (${err.cause.message})` : '';
  return `${err.message || err}${cause}`;
}

// A request handler that throws where nothing catches it is, by default,
// fatal: Node exits on an unhandled rejection, the container dies, and
// what reaches the user is a Cloudflare "502 Bad gateway" from Discord's
// proxy with nothing in it about what actually went wrong. That failure
// mode cost real time here, so it gets a net. Staying alive after an
// uncaughtException is a POC-grade choice -- process state could in
// principle be suspect -- but for a service that only proxies two HTTP
// calls, an entry in the log beats a container that vanished.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (request dropped, server staying up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server staying up):', err);
});

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);

  // Checked at startup rather than on the first request: a base URL
  // without a scheme is the single likeliest way this is misconfigured,
  // and `new URL()` throwing on it is what turns into an opaque "fetch
  // failed" much later, on a request nobody is watching the logs for.
  if (!GREEN_API_BASE_URL) {
    console.warn('GREEN_API_BASE_URL is not set; /api/party cannot work.');
    return;
  }
  try {
    const parsed = new URL(GREEN_API_BASE_URL);
    console.log(`Battle engine base URL: ${parsed.protocol}//${parsed.host}`);
    if (GREEN_API_BASE_URL.endsWith('/')) {
      console.warn('GREEN_API_BASE_URL ends with a slash; paths will contain "//".');
    }
  } catch {
    console.error(
      `GREEN_API_BASE_URL is not a valid URL: ${GREEN_API_BASE_URL} ` +
        '-- it needs a scheme, e.g. https://host, not just host.'
    );
  }
});