import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { attachShoutbox } from '../shoutbox.js';

test('shoutbox shutdown terminates connected clients and lets the HTTP server close', async () => {
  const server = createServer((_request, response) => response.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const publicOrigin = `http://127.0.0.1:${port}`;
  const transport = attachShoutbox({
    authService: {
      getSession: async () => ({
        account: {
          createdAt: new Date(0),
          id: 'account-id',
          preferences: { shoutboxEnabled: true },
          role: 'member',
        },
      }),
    },
    publicOrigin,
    readSessionToken: () => 'session-token',
    repository: {
      getShoutboxSnapshot: async () => ({ cursor: '0', history: [], pinned: [] }),
    },
    requestLimiter: null,
    server,
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}/shoutbox`, { origin: publicOrigin });
  await once(client, 'message');
  const clientClosed = once(client, 'close');

  await transport.close();
  await clientClosed;
  await new Promise((resolve) => server.close(resolve));

  assert.equal(client.readyState, WebSocket.CLOSED);
  await transport.close();
});
