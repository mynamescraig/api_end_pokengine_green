import { DiscordSDK } from '@discord/embedded-app-sdk';

const statusEl = document.getElementById('status');

async function main() {
  const clientId = window.DISCORD_CLIENT_ID;
  if (!clientId) {
    throw new Error('DISCORD_CLIENT_ID was not injected into the page.');
  }

  const discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  // Opens Discord's OAuth modal (skipped if already authorized) and hands
  // back a one-time code -- exchanged for a real token server-side next,
  // since the client secret that step needs can never reach this file.
  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    scope: ['identify'],
  });

  const tokenResponse = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  }
  const { access_token: accessToken } = await tokenResponse.json();

  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  if (auth == null) {
    throw new Error('authenticate() returned no result.');
  }
  return auth;
}

main()
  .then((auth) => {
    statusEl.textContent = `Logged in as ${auth.user.username}`;
  })
  .catch((err) => {
    console.error('Discord Activity auth flow failed:', err);
    statusEl.textContent = `Auth failed: ${err.message}`;
  });
