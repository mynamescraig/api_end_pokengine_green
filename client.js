import { DiscordSDK } from '@discord/embedded-app-sdk';

// Bumped by hand whenever this file changes in a way worth confirming
// reached the client. Printed on the page, so a stale cached bundle is
// immediately obvious instead of being indistinguishable from a bug --
// the Activity is tested on mobile, where there are no devtools to check.
const BUILD_MARKER = 'party-v5';

const statusEl = document.getElementById('status');
const partyEl = document.getElementById('party');
const logEl = document.getElementById('log');

// Everything interesting goes on the page, not just the console: inside
// the Discord mobile client there is no way to read a console, so a step
// that silently never happens is otherwise indistinguishable from one
// that hung.
function log(message, isError = false) {
  const line = document.createElement('div');
  if (isError) {
    line.className = 'err';
  }
  line.textContent = message;
  logEl.appendChild(line);
  console.log(message);
}

async function main() {
  log(`build ${BUILD_MARKER} · server booted ${window.SERVER_BOOT || 'unknown'}`);

  const clientId = window.DISCORD_CLIENT_ID;
  if (!clientId) {
    throw new Error('DISCORD_CLIENT_ID was not injected into the page.');
  }

  const discordSdk = new DiscordSDK(clientId);
  log('waiting for SDK ready...');
  await discordSdk.ready();
  log('SDK ready');

  // Opens Discord's OAuth modal (skipped if already authorized) and hands
  // back a one-time code -- exchanged for a real token server-side next,
  // since the client secret that step needs can never reach this file.
  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    scope: ['identify'],
  });
  log('authorized');

  const tokenResponse = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  }
  const { access_token: accessToken } = await tokenResponse.json();
  log('token exchanged');

  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  if (auth == null) {
    throw new Error('authenticate() returned no result.');
  }
  statusEl.textContent = `Logged in as ${auth.user.username}`;
  log('authenticated');

  // auth.access_token, not the one-time authorize() code -- the party
  // lookup re-verifies identity server-side against this same token
  // (see server.js's handlePartyLookup), it doesn't trust anything the
  // client asserts about who it is.
  const partyToken = auth.access_token || accessToken;
  log(`fetching party (token from ${auth.access_token ? 'authenticate' : 'exchange'})...`);

  const partyResponse = await fetch('/api/party', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: partyToken }),
  });
  log(`party response: ${partyResponse.status}`);

  const raw = await partyResponse.text();
  if (!partyResponse.ok) {
    throw new Error(`Party lookup failed: ${partyResponse.status} ${raw}`);
  }

  // The server reports its own failures as 200 with {ok: false} -- see
  // sendFailure in server.js for why a 5xx would lose the message
  // entirely on the way through Discord's proxy.
  const payload = JSON.parse(raw);
  if (payload.ok === false) {
    const parts = [payload.error];
    if (payload.upstreamStatus) {
      parts.push(`engine status ${payload.upstreamStatus}`);
    }
    if (payload.detail) {
      parts.push(payload.detail);
    }
    throw new Error(parts.join(' :: '));
  }

  const { party } = payload;
  log(`party members: ${Array.isArray(party) ? party.length : 'not an array'}`);
  renderParty(party);
}

function renderParty(party) {
  partyEl.replaceChildren();
  if (!party || party.length === 0) {
    const li = document.createElement('li');
    li.textContent = '(no party)';
    partyEl.appendChild(li);
    return;
  }
  for (const name of party) {
    const li = document.createElement('li');
    li.textContent = name;
    partyEl.appendChild(li);
  }
}

/**
 * On failure, pull /api/diag and put it on the page.
 *
 * The failing request keeps coming back as a 502 written by Discord's
 * proxy, which says nothing about what the server saw -- /api/diag is
 * where that lives. Fetching it from here rather than asking someone to
 * open a second URL keeps the whole picture on the one screen being
 * looked at, which matters when the only way to read any of this is a
 * phone screenshot. It is also a much cheaper request (two probes in
 * parallel, capped at 5s) than the one that failed, so it stands a
 * better chance of finishing inside whatever patience the proxy has.
 */
async function showDiagnostics() {
  log('--- fetching /api/diag ---');
  try {
    const response = await fetch('/api/diag');
    const raw = await response.text();
    log(`diag ${response.status}: ${raw.slice(0, 1200)}`);
  } catch (err) {
    log(`diag unavailable: ${err && err.message ? err.message : err}`, true);
  }
}

main().catch((err) => {
  console.error('Discord Activity flow failed:', err);
  statusEl.textContent = 'Something went wrong';
  // Truncated: a Cloudflare error page is ~8KB of HTML, and letting it
  // fill the screen buries the diagnostics printed right after it.
  const message = err && err.message ? err.message : String(err);
  log(`FAILED: ${message.slice(0, 300)}`, true);
  showDiagnostics();
});
