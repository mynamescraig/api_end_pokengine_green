import { DiscordSDK } from '@discord/embedded-app-sdk';

// Bumped by hand whenever this file changes in a way worth confirming
// reached the client. Printed on the page, so a stale cached bundle is
// immediately obvious instead of being indistinguishable from a bug --
// the Activity is tested on mobile, where there are no devtools to check.
const BUILD_MARKER = 'pc-v4';

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

// Neither a linked @font-face nor a data: URI @font-face actually loads
// inside Discord's Activity iframe -- both go through the font loading
// algorithm's URL fetch step, which its CSP font-src blocks (a parse
// failure and a CSP-blocked fetch both surface as the same generic
// "network error", so the two looked identical from here). Fetching the
// raw bytes ourselves and constructing a FontFace directly from them
// skips that step entirely: no URL is ever handed to font-src, so
// there's nothing for it to block. fetch() itself is governed by
// connect-src, which the party/pc calls already prove is open
// same-origin. Fire-and-forget, run alongside main() rather than
// awaited in it -- document.fonts.add() repaints any text already using
// the font automatically once it resolves, so nothing here needs to
// block rendering.
async function loadCustomFont() {
  if (!('fonts' in document) || typeof FontFace === 'undefined') {
    log('Font Loading API unavailable -- cannot load the custom font', true);
    return;
  }
  try {
    const response = await fetch('/assets/pokemon-ds.otf');
    if (!response.ok) {
      log(`custom font fetch failed: HTTP ${response.status}`, true);
      return;
    }
    const bytes = await response.arrayBuffer();
    const fontFace = new FontFace('Pokemon DS', bytes);
    await fontFace.load();
    document.fonts.add(fontFace);
    log('custom font "Pokemon DS" loaded OK');
  } catch (err) {
    log(`custom font "Pokemon DS" failed to load: ${err && err.message ? err.message : err}`, true);
  }
}

async function main() {
  log(`build ${BUILD_MARKER} · server booted ${window.SERVER_BOOT || 'unknown'}`);
  loadCustomFont();

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
  // A stale card from the box just left has nothing left to show data
  // for once the page turns.
  closeSummary();
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

function spriteUrl(iconUrl) {
  // Proxied rather than loaded straight from the CDN: an Activity's
  // iframe needs an explicit URL Mapping before an external origin will
  // load, and same-origin needs no configuration at all.
  return `/api/sprite?url=${encodeURIComponent(iconUrl)}`;
}

function renderCell(member) {
  const cell = document.createElement('div');
  cell.className = member ? 'pc-cell filled' : 'pc-cell empty';
  if (!member) {
    return cell;
  }

  if (member.iconUrl) {
    const img = document.createElement('img');
    img.src = spriteUrl(member.iconUrl);
    img.alt = member.name;
    img.loading = 'lazy';
    cell.appendChild(img);
  }

  // title, so a tap-and-hold or hover names the occupant too -- the grid
  // is too small for a permanent label, and this is a hint on top of the
  // tap-to-open summary below, not a substitute for it.
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

  cell.addEventListener('click', () => openSummary(member));
  return cell;
}

/**
 * The tap-to-open summary card, built entirely from data the box fetch
 * already returned -- member.detail, attached server-side in
 * summarizePokemon (server.js). No request happens on open, which is
 * also why it can't fail: there's nothing left to go wrong once the box
 * itself has loaded.
 */
function openSummary(member) {
  closeSummary();

  const overlay = document.createElement('div');
  overlay.id = 'summary-overlay';
  // Tapping the dark backdrop closes it; tapping the card itself must
  // not, so the card's own click is stopped from bubbling back up here.
  overlay.addEventListener('click', closeSummary);

  const card = document.createElement('div');
  card.id = 'summary-card';
  card.addEventListener('click', (event) => event.stopPropagation());

  card.appendChild(buildSummaryHead(member));
  if (member.detail && member.detail.isEgg) {
    card.appendChild(buildEggSection(member.detail));
  } else if (member.detail) {
    card.appendChild(buildInfoSection(member, member.detail));
    card.appendChild(buildHealthSection(member.detail));
    if (member.detail.stats) {
      card.appendChild(buildStatsSection(member.detail.stats));
    }
    if (member.detail.moves && member.detail.moves.length > 0) {
      card.appendChild(buildMovesSection(member.detail.moves));
    }
  }

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function closeSummary() {
  const existing = document.getElementById('summary-overlay');
  if (existing) {
    existing.remove();
  }
}

function buildSummaryHead(member) {
  const head = document.createElement('div');
  head.className = 'summary-head';

  if (member.iconUrl) {
    const img = document.createElement('img');
    img.src = spriteUrl(member.iconUrl);
    img.alt = member.name;
    head.appendChild(img);
  }

  const names = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'summary-name';
  name.textContent = (member.shiny ? '✨ ' : '') + member.name;
  names.appendChild(name);

  if (!member.isEgg) {
    const sub = document.createElement('div');
    sub.className = 'summary-sub';
    const bits = [`Lv ${member.level}`];
    if (member.name !== member.species) {
      bits.push(member.species);
    }
    sub.textContent = bits.join(' · ');
    names.appendChild(sub);
  }
  head.appendChild(names);

  const close = document.createElement('button');
  close.className = 'summary-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeSummary);
  head.appendChild(close);

  return head;
}

function buildEggSection(detail) {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h3 = document.createElement('h3');
  h3.textContent = 'Incubation';
  section.appendChild(h3);

  const row = document.createElement('div');
  row.className = 'summary-row';
  const label = document.createElement('span');
  label.textContent = 'Progress';
  const value = document.createElement('span');
  value.textContent =
    detail.hatchRequiredBlocks
      ? `${detail.hatchProgressBlocks} / ${detail.hatchRequiredBlocks} blocks`
      : 'Unknown';
  row.append(label, value);
  section.appendChild(row);
  return section;
}

function buildInfoSection(member, detail) {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h3 = document.createElement('h3');
  h3.textContent = 'Info';
  section.appendChild(h3);

  const type = [detail.type1, detail.type2].filter(Boolean).join(' / ') || 'Unknown';
  const rows = [
    ['Type', type],
    ['Nature', titleCase(detail.nature)],
    ['Ability', titleCase(detail.ability)],
  ];
  if (detail.heldItem) {
    rows.push(['Held Item', titleCase(detail.heldItem)]);
  }
  if (detail.ballType) {
    rows.push(['Caught with', titleCase(detail.ballType)]);
  }
  if (typeof detail.happiness === 'number') {
    rows.push(['Friendship', `${detail.happiness}/255`]);
  }
  if (detail.originalTrainerName) {
    rows.push(['Original Trainer', `${detail.originalTrainerName} (traded)`]);
  }
  for (const [label, value] of rows) {
    section.appendChild(summaryRow(label, value));
  }
  return section;
}

function buildHealthSection(detail) {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h3 = document.createElement('h3');
  h3.textContent = 'Health';
  section.appendChild(h3);

  if (typeof detail.currentHp === 'number' && detail.maxHp) {
    const bar = document.createElement('div');
    bar.className = 'summary-hpbar';
    const fill = document.createElement('div');
    fill.className = 'summary-hpbar-fill';
    const pct = Math.max(0, Math.min(100, (detail.currentHp / detail.maxHp) * 100));
    fill.style.width = `${pct}%`;
    // Plain red/yellow/green threshold rather than importing a palette
    // for one bar -- matches the HP-percent bands the rest of this
    // project's own rendering already uses.
    fill.style.background = pct > 50 ? '#3ba55c' : pct > 20 ? '#faa61a' : '#ed4245';
    bar.appendChild(fill);
    section.appendChild(bar);
  }

  const hpText = typeof detail.currentHp === 'number' && detail.maxHp
    ? `${detail.currentHp}/${detail.maxHp} HP`
    : 'Unknown';
  const status = detail.statusCondition ? ` · ${titleCase(detail.statusCondition)}` : '';
  section.appendChild(summaryRow('HP', hpText + status));

  if (!detail.atMaxLevel && detail.xpNeededForLevel) {
    section.appendChild(
      summaryRow('EXP', `${detail.xpIntoLevel}/${detail.xpNeededForLevel} to next level`)
    );
  } else if (detail.atMaxLevel) {
    section.appendChild(summaryRow('EXP', 'Max level'));
  }
  return section;
}

function buildStatsSection(stats) {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h3 = document.createElement('h3');
  h3.textContent = 'Stats';
  section.appendChild(h3);

  const labels = [
    ['hp', 'HP'], ['attack', 'Attack'], ['defense', 'Defense'],
    ['special_attack', 'Sp. Atk'], ['special_defense', 'Sp. Def'], ['speed', 'Speed'],
  ];
  for (const [key, label] of labels) {
    if (stats[key] !== undefined) {
      section.appendChild(summaryRow(label, String(stats[key])));
    }
  }
  return section;
}

function buildMovesSection(moves) {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h3 = document.createElement('h3');
  h3.textContent = 'Moveset';
  section.appendChild(h3);

  const grid = document.createElement('div');
  grid.className = 'summary-moves';
  for (const move of moves) {
    const card = document.createElement('div');
    card.className = 'summary-move';
    const name = document.createElement('div');
    name.className = 'move-name';
    name.textContent = titleCase(move.name);
    const pp = document.createElement('div');
    pp.className = 'move-pp';
    pp.textContent = move.maxPp != null ? `${move.currentPp}/${move.maxPp} PP` : '';
    card.append(name, pp);
    grid.appendChild(card);
  }
  section.appendChild(grid);
  return section;
}

function summaryRow(label, value) {
  const row = document.createElement('div');
  row.className = 'summary-row';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

// Engine data is lowercase, hyphen-or-underscore slugs ("poke-ball",
// "rough-skin") -- matches the naming convention db/pokemon_instances.py
// and cogs/rendering.py's own slug_display already document.
function titleCase(slug) {
  if (!slug) {
    return 'Unknown';
  }
  return slug
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
