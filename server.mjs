import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAPI } from './lib/app-api.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

export function createApp({ libraryRoot = path.join(root, 'word_list'), recordsRoot = path.join(root, 'records'), ...dependencies } = {}) {
  const api = createAPI({ libraryRoot, recordsRoot, ...dependencies });
  const server = createServer(async (request, response) => {
    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        ...headers,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      const host = request.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) return send(403, 'application/json', JSON.stringify({ error: '로컬 주소에서만 사용할 수 있습니다.' }));
      const url = new URL(request.url, `http://${host}`);
      if (!['GET', 'HEAD'].includes(request.method)) {
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') return send(403, 'application/json', JSON.stringify({ error: '다른 사이트의 요청은 허용하지 않습니다.' }));
      }
      if (url.pathname.startsWith('/api/')) return await api.handle(request, url, send);
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'text/plain', '지원하지 않는 요청입니다.');
      const requested = decodeURIComponent(url.pathname);
      const filename = path.resolve(publicRoot, `.${requested === '/' ? '/index.html' : requested}`);
      if (!filename.startsWith(`${publicRoot}${path.sep}`)) return send(403, 'text/plain', '접근할 수 없습니다.');
      if (!types[path.extname(filename)]) return send(404, 'text/plain', '파일을 찾을 수 없습니다.');
      const content = await readFile(filename);
      send(200, types[path.extname(filename)], content);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return send(404, 'text/plain', '파일을 찾을 수 없습니다.');
      if (error instanceof URIError) return send(400, 'text/plain', '잘못된 주소입니다.');
      const status = error.statusCode || error.status || (error instanceof TypeError ? 400 : 500);
      if (status === 500) console.error(error);
      send(status, 'application/json', JSON.stringify({ error: error.message || '요청을 처리하지 못했습니다.' }));
    }
  });
  server.on('close', () => api.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535 사이 숫자여야 합니다.');
  const server = createApp();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `${port}번 포트가 사용 중입니다. PORT=3001 npm start로 실행해 주세요.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`\n  WordPOP  →  http://127.0.0.1:${port}\n  종료하려면 Ctrl+C를 누르세요.\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
