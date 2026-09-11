import { DiscordSDK } from '@discord/embedded-app-sdk';

// Bumped by hand whenever this file changes in a way worth confirming
// reached the client. Printed on the page, so a stale cached bundle is
// immediately obvious instead of being indistinguishable from a bug --
// the Activity is tested on mobile, where there are no devtools to check.
const BUILD_MARKER = 'pc-v1';

const statusEl = document.getElementById('status');
const partyEl = document.getElementById('party');
const pcEl = document.getElementById('pc');
const logEl = document.getElementById('log');

// Held so turning a page can re-ask without re-running the whole auth
// flow. Set once authenticate() succeeds.
let sessionToken = null;

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

  sessionToken = partyToken;
  // No box named: Green reads that as "wherever this trainer left off",
  // which is what opening the PC should do rather than always landing on
  // box one.
  await loadBox(undefined);
}

/**
 * Fetch and draw one box.
 *
 * `box` undefined on the first call and an explicit number when turning
 * a page -- zero is a real box, so the distinction is undefined vs
 * number, not falsy vs truthy.
 */
async function loadBox(box) {
  const body = { access_token: sessionToken };
  if (box !== undefined) {
    body.box = box;
  }

  const response = await fetch('/api/pc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.ok === false) {
    throw new Error([payload.error, payload.detail].filter(Boolean).join(' :: '));
  }

  log(`box ${payload.box + 1}/${payload.boxCount}: ${payload.members.length} stored`);
  renderBox(payload);
}

function renderBox(data) {
  pcEl.replaceChildren();

  const header = document.createElement('div');
  header.className = 'pc-header';

  const previous = document.createElement('button');
  previous.className = 'pc-nav';
  previous.textContent = '‹';
  previous.disabled = data.box <= 0;

  const title = document.createElement('div');
  title.className = 'pc-title';
  // Green sends null when a box was never renamed -- "Box N" is a display
  // decision, deliberately not stored per row.
  title.textContent = data.name || `Box ${data.box + 1}`;

  const count = document.createElement('div');
  count.className = 'pc-count';
  count.textContent = `${data.storedCount} stored · box ${data.box + 1} of ${data.boxCount}`;
  title.appendChild(count);

  const next = document.createElement('button');
  next.className = 'pc-nav';
  next.textContent = '›';
  next.disabled = data.box >= data.boxCount - 1;

  // Wrapping around at the ends was deliberately not done: the PC has a
  // real first and last box, and a disabled arrow says where you are.
  previous.addEventListener('click', () => turnPage(data.box - 1));
  next.addEventListener('click', () => turnPage(data.box + 1));

  header.append(previous, title, next);
  pcEl.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'pc-grid';

  // Green sends only the FILLED slots, because a box is thirty positions
  // with holes rather than a list -- so the grid is drawn from the slot
  // numbers, not from the order members arrive in.
  const bySlot = new Map(data.members.map((member) => [member.slot, member]));
  for (let slot = 0; slot < data.boxSize; slot += 1) {
    grid.appendChild(renderCell(bySlot.get(slot)));
  }

  pcEl.appendChild(grid);
}

function renderCell(member) {
  const cell = document.createElement('div');
  cell.className = member ? 'pc-cell' : 'pc-cell empty';
  if (!member) {
    return cell;
  }

  if (member.iconUrl) {
    const img = document.createElement('img');
    // Proxied rather than loaded straight from the CDN: an Activity's
    // iframe needs an explicit URL Mapping before an external origin
    // will load, and same-origin needs no configuration at all.
    img.src = `/api/sprite?url=${encodeURIComponent(member.iconUrl)}`;
    img.alt = member.name;
    img.loading = 'lazy';
    cell.appendChild(img);
  }

  // title, so a tap-and-hold or hover names the occupant -- the grid is
  // too small for labels, and this is a browsing view with no detail
  // screen behind it yet.
  cell.title = member.isEgg
    ? 'Egg'
    : `${member.name}${member.level ? ` · Lv ${member.level}` : ''}`;

  if (member.shiny) {
    const mark = document.createElement('span');
    mark.className = 'shiny';
    mark.textContent = '✨';
    cell.appendChild(mark);
  }
  if (member.level && !member.isEgg) {
    const level = document.createElement('span');
    level.className = 'lvl';
    level.textContent = member.level;
    cell.appendChild(level);
  }
  return cell;
}

function turnPage(box) {
  loadBox(box).catch((err) => {
    log(`could not turn to box ${box + 1}: ${err && err.message ? err.message : err}`, true);
  });
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
