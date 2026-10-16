// Local, read-only review page. Fixed origin preserves browser label drafts.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(__dirname, '../../docs/ai-mapping/embeddings-review.html')
http.createServer((request, response) => {
  if (request.url !== '/' || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404); response.end(); return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  if (request.method === 'HEAD') { response.end(); return }
  fs.createReadStream(file).on('error', () => { response.destroy() }).pipe(response)
}).listen(60712, '127.0.0.1', () => console.log('AIMapping review: http://127.0.0.1:60712/'))
