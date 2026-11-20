// Сервер каси ЗначокUA. Усі файли лежать в одній папці (корінь репозиторію).
const http = require("http"), fs = require("fs"), path = require("path");
try { // settings.env — лише для запуску на комп'ютері; на Render використовуйте Environment
  for (const l of fs.readFileSync(path.join(__dirname, "settings.env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith("#") && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const pos = require("./pos");
const PAGE = path.join(__dirname, "index.html");
if (!process.env.POS_OWNER_EMAIL || !process.env.POS_OWNER_PASSWORD)
  console.warn("УВАГА: не задано POS_OWNER_EMAIL / POS_OWNER_PASSWORD — увійти не вдасться.");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/pos/")) return await pos(req, res, url);
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/pos.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(PAGE).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found");
  } catch (e) { if (!res.headersSent) { res.writeHead(500); res.end("Помилка сервера"); } }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Каса запущена на порту " + PORT));
