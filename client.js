import { DiscordSDK } from '@discord/embedded-app-sdk';

// Bumped by hand whenever this file changes in a way worth confirming
// reached the client. Printed on the page, so a stale cached bundle is
// immediately obvious instead of being indistinguishable from a bug --
// the Activity is tested on mobile, where there are no devtools to check.
const BUILD_MARKER = 'party-v3';

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

  const { party } = JSON.parse(raw);
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

main().catch((err) => {
  console.error('Discord Activity flow failed:', err);
  statusEl.textContent = 'Something went wrong';
  log(`FAILED: ${err && err.message ? err.message : err}`, true);
});
