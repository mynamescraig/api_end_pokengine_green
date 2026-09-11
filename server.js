const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5173;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// Green's own HTTP API, never its database directly -- see handlePartyLookup.
// Trailing slashes stripped, because the configured value is a base and
// every use of it appends a path starting with "/". Left as-is, a base
// ending in "/" produces "https://host//v1/trainers/...", and the
// engine's router matches "/v1/trainers/..." exactly -- the double slash
// is a different path, so it 404s. Normalising here rather than asking
// the environment variable to be written a particular way: both spellings
// are things people reasonably type, and only one of them can be wrong.
const GREEN_API_BASE_URL = process.env.GREEN_API_BASE_URL
  ? process.env.GREEN_API_BASE_URL.replace(/\/+$/, '')
  : process.env.GREEN_API_BASE_URL;
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
// Kept deliberately tight, and that is the point rather than an
// optimisation: Discord's Activity proxy has its own timeout, and a 502
// from it arrives with no information at all. Whatever this server has
// to say about a slow call is only useful if it says it FIRST, so the
// two caps together stay well under ten seconds.
const DISCORD_TIMEOUT_MS = 4_000;
const ENGINE_TIMEOUT_MS = 5_000;

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

// A short in-memory history of what this server actually handled, so the
// question "did the request even get here?" can be answered from a
// browser instead of from logs. Every failure so far has been a 502
// written by Discord's proxy, which says nothing about whether this
// process ever saw the request -- and that is the difference between a
// bug in this code and a problem in front of it.
//
// `aborted` is the interesting one: it means the caller hung up before
// this server finished responding, which is exactly the fingerprint of
// the proxy giving up on us.
const RECENT_REQUEST_LIMIT = 25;
const recentRequests = [];

function recordRequest(entry) {
  recentRequests.push(entry);
  if (recentRequests.length > RECENT_REQUEST_LIMIT) {
    recentRequests.shift();
  }
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  let settled = false;
  const finish = (aborted) => {
    if (settled) {
      return;
    }
    settled = true;
    recordRequest({
      at: new Date(startedAt).toISOString(),
      method: req.method,
      path: new URL(req.url, 'http://localhost').pathname,
      status: aborted ? null : res.statusCode,
      ms: Date.now() - startedAt,
      ...(aborted ? { aborted: true } : {}),
    });
  };
  res.on('finish', () => finish(false));
  res.on('close', () => finish(!res.writableEnded));

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

  if (req.method === 'GET' && pathname === '/api/diag') {
    return handleDiagnostics(res);
  }

  if (req.method === 'POST' && pathname === '/api/token') {
    return handleTokenExchange(req, res);
  }
  if (req.method === 'POST' && pathname === '/api/party') {
    return handlePartyLookup(req, res);
  }
  if (req.method === 'POST' && pathname === '/api/pc') {
    return handlePcLookup(req, res);
  }
  if (req.method === 'GET' && pathname === '/api/sprite') {
    return handleSprite(req, res);
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveIndex(res);
  }
  if (req.method === 'GET' && pathname === '/bundle.js') {
    return serveBundle(res);
  }
  const staticAsset = STATIC_ASSETS[pathname];
  if (req.method === 'GET' && staticAsset) {
    return serveStaticAsset(res, staticAsset);
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

// Design assets -- committed files that only change when someone commits
// a new one, unlike index.html/bundle.js which change on every deploy.
// Cached hard rather than no-store for exactly that reason.
const STATIC_ASSETS = {
  '/assets/pokemon-ds.otf': {
    file: 'assets/font/pkmn_ds/pokemon-ds-font.otf',
    type: 'font/otf',
  },
  '/assets/summary-atlas.png': {
    // The 48x48 crop, not the 64x64 file as committed: the source has a
    // 16px transparent margin on its right and bottom edges (a 64x64
    // canvas holding a 3x3-of-16px, i.e. 48x48, atlas), and CSS
    // border-image-slice can only cut a rectangle at a fixed distance
    // from each of the image's TRUE edges -- it has no way to say "skip
    // 16px of padding, then slice." Slicing the original directly would
    // pull the right/bottom edge tiles from that empty margin instead of
    // the real artwork. Cropped once (see assets/pc/summary_atlas_
    // 9slice.png) rather than at request time, since this never changes
    // between requests and Node has no image library already in this
    // project to justify adding one for a one-time 64x64 -> 48x48 crop.
    file: 'assets/pc/summary_atlas_9slice.png',
    type: 'image/png',
  },
};

function serveStaticAsset(res, { file, type }) {
  fs.readFile(path.join(__dirname, file), (err, contents) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable' });
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

/**
 * The shared shape of every authenticated lookup here: read a JSON body,
 * prove who the caller is against Discord, ask Green, hand back what it
 * said.
 *
 * Everything goes through Green's own HTTP API and never its MySQL
 * database. Green's README documents exactly one precedent for an
 * external consumer (the Paper Minecraft plugin) and it goes through this
 * same API, specifically so access control (api/auth.py) and the
 * trainer_id/account-linking rules (db/trainer_links.py -- linking
 * repoints a Minecraft player's data to live under their Discord
 * snowflake) stay owned in one place. A SQL client here would reimplement
 * both and drift from Green's schema; going through the API inherits
 * fixes for free.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Who does this access token actually belong to?
 *
 * Asked of Discord rather than taken from the request body on purpose: a
 * client-supplied id would let any caller read any player's storage.
 * Returns {discordId} or {failure}, so the caller decides how to answer.
 */
async function verifyDiscordIdentity(accessToken) {
  const startedAt = Date.now();
  try {
    const response = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { failure: { error: 'Could not verify Discord identity.', upstreamStatus: response.status } };
    }
    const { id } = await response.json();
    console.log(`Discord identity resolved in ${Date.now() - startedAt}ms`);
    return { discordId: id };
  } catch (err) {
    const timedOut = Boolean(err && err.name === 'TimeoutError');
    console.error(
      `Discord identity lookup ${timedOut ? 'timed out' : 'failed'} after ${Date.now() - startedAt}ms:`,
      err
    );
    return {
      failure: {
        error: timedOut
          ? `Discord did not respond within ${DISCORD_TIMEOUT_MS}ms.`
          : 'Could not reach Discord to verify identity.',
        detail: describeError(err),
      },
    };
  }
}

/**
 * GET a path from Green, parsed. Returns {data} or {failure}.
 *
 * Each failure names itself rather than collapsing into one message:
 * unreachable, too slow, rejected, and unparseable are four different
 * problems with four different fixes, and reporting them identically is
 * what made an earlier bug here take far longer than it should have.
 */
async function getFromEngine(path) {
  const url = `${GREEN_API_BASE_URL}${path}`;
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${GREEN_API_TOKEN}` },
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
    console.log(`Battle engine answered ${response.status} for ${path} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    const timedOut = Boolean(err && err.name === 'TimeoutError');
    console.error(
      `Battle engine request ${timedOut ? 'timed out' : 'failed'} after ${Date.now() - startedAt}ms:`,
      url,
      err
    );
    return {
      failure: {
        error: timedOut
          ? `The battle engine did not respond within ${ENGINE_TIMEOUT_MS}ms.`
          : 'Could not reach the battle engine.',
        detail: describeError(err),
      },
    };
  }

  let rawBody;
  try {
    rawBody = await response.text();
  } catch (err) {
    // Reading the body can fail on its own when a connection drops
    // mid-response. Unguarded, that rejects inside an async handler,
    // which Node exits the process for -- one bad response would take the
    // whole service down.
    console.error('Could not read the battle engine response body:', err);
    return { failure: { error: 'The battle engine response could not be read.', detail: describeError(err) } };
  }

  if (!response.ok) {
    console.error('Battle engine rejected the request:', path, response.status, rawBody);
    return {
      failure: {
        error: 'The battle engine rejected the request.',
        upstreamStatus: response.status,
        detail: rawBody.slice(0, 200),
      },
    };
  }

  try {
    return { data: JSON.parse(rawBody) };
  } catch (err) {
    console.error('Could not parse the battle engine response:', err, rawBody.slice(0, 200));
    return { failure: { error: 'The battle engine returned something unreadable.', detail: describeError(err) } };
  }
}

/**
 * Body -> verified Discord id, or a response already sent.
 * Returns null when it has answered the request itself.
 */
async function authenticatedTrainerId(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }

  const accessToken = payload.access_token;
  if (!accessToken) {
    sendJson(res, 400, { error: 'Missing access_token' });
    return null;
  }
  if (!GREEN_API_BASE_URL || !GREEN_API_TOKEN) {
    console.error('GREEN_API_BASE_URL / GREEN_API_TOKEN is not set.');
    sendFailure(res, { error: 'Server is not configured to reach the battle engine.' });
    return null;
  }

  const { discordId, failure } = await verifyDiscordIdentity(accessToken);
  if (failure) {
    sendFailure(res, failure);
    return null;
  }

  // trainer_id IS the Discord snowflake -- true for a Discord-originated
  // account, and still true after a Minecraft player links their Discord,
  // since linking repoints their data to live under it. A player who has
  // never linked simply has no row, which Green reports as empty rather
  // than as an error.
  return { discordId, requestBody: payload };
}

async function handlePartyLookup(req, res) {
  const authenticated = await authenticatedTrainerId(req, res);
  if (!authenticated) {
    return;
  }

  const { data, failure } = await getFromEngine(`/v1/trainers/${authenticated.discordId}/party`);
  if (failure) {
    sendFailure(res, failure);
    return;
  }

  // proper_name, not nickname -- the ask is species names, and an egg
  // slot's proper_name already comes back as "Egg" because Green masks it
  // at the API boundary, so no special-casing is needed here.
  sendJson(res, 200, { party: (data.members || []).map((member) => member.proper_name) });
}

/**
 * One box of the player's PC, shaped for a grid.
 *
 * Green returns only the slots that are FILLED, plus the box size -- a
 * box is thirty positions with holes in it, not a list. The client draws
 * thirty cells and puts each member in the slot it names, so the holes
 * are the client's business and the engine never has to send nulls.
 *
 * `box` is passed straight through when given and omitted when not:
 * omitting it means "wherever this trainer left off", which is what
 * opening the PC should do, while turning a page names its box. Zero is
 * a real box number, so the check is for undefined rather than falsy.
 */
async function handlePcLookup(req, res) {
  const authenticated = await authenticatedTrainerId(req, res);
  if (!authenticated) {
    return;
  }

  const requestedBox = authenticated.requestBody.box;
  const query = Number.isInteger(requestedBox) && requestedBox >= 0 ? `?box=${requestedBox}` : '';

  const { data, failure } = await getFromEngine(
    `/v1/trainers/${authenticated.discordId}/pc${query}`
  );
  if (failure) {
    sendFailure(res, failure);
    return;
  }

  sendJson(res, 200, {
    box: data.page,
    boxCount: data.page_count,
    boxSize: data.page_size,
    storedCount: data.stored_count,
    storageCap: data.storage_cap,
    // Null means this box was never named; "Box N" is a display decision
    // and Green deliberately doesn't store it on every row.
    name: data.name,
    wallpaper: data.wallpaper,
    members: (data.members || []).map((member) => ({
      uuid: member.uuid,
      slot: member.box_slot,
      name: member.nickname || member.proper_name,
      species: member.proper_name,
      level: member.level,
      shiny: Boolean(member.shiny),
      isEgg: Boolean(member.is_egg),
      iconUrl: member.icon_url,
      // Green's own GET /v1/trainers/{id}/pc already runs
      // get_instance_detail + _attach_display_detail per member (the
      // engine needs the full row to compute box_slot placement in the
      // first place), so this is already-fetched data, not a second
      // lookup -- summarizePokemon just narrows the field names down to
      // what a summary card draws, one tap away with no extra request.
      detail: summarizePokemon(member),
    })),
  });
}

/**
 * The subset of Green's per-instance detail a summary card draws,
 * renamed to the same camelCase the rest of this service's JSON uses.
 * Kept separate from the grid's own top-level fields (name/species/
 * level/etc. above) since a cell needs those to draw itself even before
 * anyone taps it, while this only matters once they do.
 */
function summarizePokemon(member) {
  if (member.is_egg) {
    // Masked at the engine boundary already -- species 0, no ability,
    // nature or moves -- so a tapped egg gets its own small card instead
    // of one full of blanks.
    return {
      isEgg: true,
      hatchProgressBlocks: member.hatch_progress_blocks,
      hatchRequiredBlocks: member.hatch_required_blocks,
    };
  }

  return {
    isEgg: false,
    type1: member.type_1,
    type2: member.type_2,
    gender: member.gender,
    nature: member.nature,
    ability: member.ability,
    heldItem: member.held_item,
    ballType: member.ball_type,
    happiness: member.happiness,
    currentHp: member.current_hp,
    maxHp: member.max_hp,
    statusCondition: member.status_condition,
    stats: member.stats,
    xpIntoLevel: member.xp_into_level,
    xpNeededForLevel: member.xp_needed_for_level,
    atMaxLevel: Boolean(member.at_max_level),
    moves: (member.moves || []).map((move) => ({
      name: move.name,
      type: move.type,
      currentPp: move.current_pp,
      maxPp: move.max_pp,
    })),
    originalTrainerName: member.original_trainer_name,
    originalTrainerPlatform: member.original_trainer_platform,
  };
}

/**
 * Can this service reach the battle engine, and is its token accepted?
 *
 * A GET with no auth of its own, so it can be opened directly in a
 * browser -- which is the entire point. Every failure so far has been a
 * 502 produced by Discord's proxy, which means the answer never came
 * from this server and nothing it knows ever reached the page. Hitting
 * this URL directly takes Discord out of the path completely, so what
 * comes back is this service's own account of the engine.
 *
 * The two probes separate things that have been indistinguishable:
 * /health is unauthenticated and, by the engine's own design, never
 * touches MySQL -- so it isolates pure network reachability. The party
 * probe then adds both the bearer token and the database. Reachable but
 * unauthorized, reachable but slow, and not reachable at all stop
 * looking alike.
 *
 * It reports the engine's host but never its token, and the party probe
 * asks for trainer 0 -- the engine's reserved "wild" sentinel, which
 * owns no player's Pokemon -- so proving the token works cannot leak
 * anyone's data.
 */
async function handleDiagnostics(res) {
  if (!GREEN_API_BASE_URL || !GREEN_API_TOKEN) {
    sendJson(res, 200, {
      configured: false,
      hasBaseUrl: Boolean(GREEN_API_BASE_URL),
      hasToken: Boolean(GREEN_API_TOKEN),
      serverBoot: SERVER_BOOT,
      recentRequests,
    });
    return;
  }

  let engineHost;
  try {
    const parsed = new URL(GREEN_API_BASE_URL);
    engineHost = `${parsed.protocol}//${parsed.host}`;
  } catch {
    sendJson(res, 200, {
      configured: true,
      baseUrlValid: false,
      note: 'GREEN_API_BASE_URL is not a valid URL -- it needs a scheme, e.g. https://host',
      // JSON-stringified on purpose: the value LOOKS right when read
      // aloud, so whatever breaks it is something that doesn't show up
      // in plain text -- a stray quote, a trailing newline, a space.
      // Escaping makes those visible instead of invisible. It's a public
      // hostname, not a credential; the token is never reported here.
      rawBaseUrl: JSON.stringify(process.env.GREEN_API_BASE_URL),
      rawBaseUrlLength: (process.env.GREEN_API_BASE_URL || '').length,
      serverBoot: SERVER_BOOT,
      recentRequests,
    });
    return;
  }

  const [health, party] = await Promise.all([
    probe(`${GREEN_API_BASE_URL}/health`, {}),
    probe(`${GREEN_API_BASE_URL}/v1/trainers/0/party`, {
      Authorization: `Bearer ${GREEN_API_TOKEN}`,
    }),
  ]);

  sendJson(res, 200, {
    configured: true,
    baseUrlValid: true,
    engineHost,
    serverBoot: SERVER_BOOT,
    health,
    party,
    recentRequests,
  });
}

async function probe(url, headers) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
    const body = await response.text();
    return {
      reached: true,
      status: response.status,
      ms: Date.now() - startedAt,
      body: body.slice(0, 160),
    };
  } catch (err) {
    return {
      reached: false,
      timedOut: Boolean(err && err.name === 'TimeoutError'),
      ms: Date.now() - startedAt,
      error: describeError(err),
    };
  }
}

// The sprite CDN Green's own icon_url values point at. Sprites are
// proxied through this server rather than loaded straight from there,
// because an Activity runs inside Discord's iframe, where external
// origins need an explicit URL Mapping in the developer portal before
// anything will load. Same-origin needs no configuration and can't
// silently break when a mapping is missing.
const SPRITE_ORIGIN = 'https://f005.backblazeb2.com/file/pokeNgine-icons-database/';

/**
 * Proxy one sprite, by the exact URL Green handed out.
 *
 * The allowlist check is the whole security story: without it this is an
 * open proxy that would fetch any URL a caller names, from inside this
 * service's own network. Only URLs that start with the sprite bucket get
 * through, so the parameter can't be pointed anywhere else.
 *
 * Cached hard, unlike the HTML and bundle: a sprite for a given species,
 * form and shininess never changes, and a PC box asks for thirty of them
 * at once.
 */
async function handleSprite(req, res) {
  const requested = new URL(req.url, 'http://localhost').searchParams.get('url');
  if (!requested || !requested.startsWith(SPRITE_ORIGIN)) {
    sendJson(res, 400, { error: 'url must be a sprite on the known icon CDN.' });
    return;
  }

  try {
    const upstream = await fetch(requested, { signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS) });
    if (!upstream.ok) {
      // A missing sprite is ordinary -- not every species/form/gender
      // combination has its own art -- so it is passed through as a plain
      // status for the page to draw a placeholder for, not logged as an
      // error on every box that contains one.
      res.writeHead(upstream.status, { 'Cache-Control': 'public, max-age=3600' });
      res.end();
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/png',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    res.end(body);
  } catch (err) {
    console.error('Sprite proxy failed:', requested, err);
    res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end();
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Failures go out as 200 with an error payload, deliberately.
 *
 * Discord's Activity proxy replaces the BODY of a 5xx response with its
 * own Cloudflare error page. This server spent five rounds of debugging
 * writing increasingly precise 502s that the page never saw -- what
 * arrived was 8KB of "502: Bad gateway" HTML every time, which is also
 * why the failure looked like a hang or a crash rather than this
 * server's own considered answer.
 *
 * A 200 carrying {ok: false} is not how a public API should report
 * failure, and it would be wrong in a service that had other consumers.
 * Here there is exactly one caller, it reads the body, and the body
 * getting through is the entire point.
 */
function sendFailure(res, body) {
  sendJson(res, 200, { ok: false, ...body });
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
    if (process.env.GREEN_API_BASE_URL !== GREEN_API_BASE_URL) {
      console.log(`(normalised from "${process.env.GREEN_API_BASE_URL}")`);
    }
  } catch {
    console.error(
      `GREEN_API_BASE_URL is not a valid URL: ${GREEN_API_BASE_URL} ` +
        '-- it needs a scheme, e.g. https://host, not just host.'
    );
  }
});