import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { serviceLinkShellMiddleware } from '../../src/utils/serviceLinkShell.js';

const html = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

describe('serviceLinkShellMiddleware', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>shell</html>');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const build = (basePath = '', shellDir: string | null = dir) => {
    const app = express();
    app.use(serviceLinkShellMiddleware(basePath, () => shellDir));
    // Stand-in for the user-scoped MCP routes that would otherwise catch these paths.
    app.all(`${basePath}/:user/mcp/:group(.*)?`, (_req, res) => res.send('mcp'));
    app.all(`${basePath}/:user/sse/:group(.*)?`, (_req, res) => res.send('sse'));
    return app;
  };

  it.each(['mcp', 'sse'])(
    'serves the app shell for a browser opening /services/%s',
    async (name) => {
      const response = await request(build())
        .get(`/services/${name}`)
        .set('Accept', html)
        .expect(200);
      expect(response.text).toBe('<html>shell</html>');
    },
  );

  it('respects the base path', async () => {
    const app = build('/hub');
    await request(app)
      .get('/hub/services/mcp')
      .set('Accept', html)
      .expect(200, '<html>shell</html>');
    expect((await request(app).get('/services/mcp').set('Accept', html)).status).toBe(404);
  });

  it('leaves MCP clients of a user named "services" alone', async () => {
    const app = build();
    await request(app).get('/services/mcp').set('Accept', 'text/event-stream').expect(200, 'mcp');
    await request(app)
      .get('/services/sse')
      .set('Accept', 'application/json, text/event-stream')
      .expect(200, 'sse');
    await request(app).get('/services/mcp').expect(200, 'mcp');
    await request(app).post('/services/mcp').set('Accept', html).expect(200, 'mcp');
  });

  it('leaves longer paths and other names alone', async () => {
    const app = build();
    await request(app).get('/services/mcp/group').set('Accept', html).expect(200, 'mcp');
    expect((await request(app).get('/services/other').set('Accept', html)).status).toBe(404);
  });

  it('falls through when there is no frontend build', async () => {
    await request(build('', null)).get('/services/mcp').set('Accept', html).expect(200, 'mcp');
  });

  it('matches the path case-insensitively, like the routes it stands in front of', async () => {
    await request(build())
      .get('/Services/MCP')
      .set('Accept', html)
      .expect(200, '<html>shell</html>');
    await request(build())
      .get('/SERVICES/Sse/')
      .set('Accept', html)
      .expect(200, '<html>shell</html>');
  });

  it('answers HEAD like GET', async () => {
    const app = build();
    const response = await request(app).head('/services/mcp').set('Accept', html).expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    await request(app).head('/services/mcp').set('Accept', 'text/event-stream').expect(200);
  });

  it('marks the answer as varying by Accept', async () => {
    const shell = await request(build()).get('/services/mcp').set('Accept', html);
    expect(shell.headers.vary).toMatch(/Accept/i);
  });

  it('runs the shell response behind the given rate limiter, and only that', async () => {
    const limiter = jest.fn((_req, res, _next) => res.status(429).send('slow down'));
    const app = express();
    app.use(serviceLinkShellMiddleware('', () => dir, limiter as never));
    app.get('/:user/mcp/:group(.*)?', (_req, res) => res.send('mcp'));

    await request(app).get('/services/mcp').set('Accept', html).expect(429);
    expect(limiter).toHaveBeenCalledTimes(1);

    await request(app).get('/services/mcp').set('Accept', 'text/event-stream').expect(200, 'mcp');
    await request(app).get('/other/mcp').set('Accept', html).expect(200, 'mcp');
    expect(limiter).toHaveBeenCalledTimes(1);
  });
});
