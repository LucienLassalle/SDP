const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const csrf = require('csurf');

const app = express();

// Toute valeur insérée dans le HTML (texte ou attribut) passe par ici
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

// Le détail de l'erreur reste dans les logs : renvoyé au client, il reflète ses entrées (XSS)
function dbError(res, err) {
  console.error(err);
  res.status(500).send('Erreur interne.');
}

// Mounted as a Docker secret: never in the environment nor in the image
const DB_PASSWORD = fs.readFileSync(process.env.DB_PASSWORD_FILE || '/run/secrets/db_password', 'utf8').trim();
if (!DB_PASSWORD) throw new Error('DB_PASSWORD must be set');

const DB_CONFIG = {
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'forum',
  password: DB_PASSWORD,
  database: 'forum'
};

const HARDCODED_ADMIN = { username: 'admin', password: 'admin123' };

const db = mysql.createPool(DB_CONFIG);

app.use(bodyParser.urlencoded({ extended: false }));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) throw new Error('SESSION_SECRET must be set');

const SESSION_MAX_AGE = 60 * 60 * 1000;

app.use(session({
  name: 'forum.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    domain: process.env.COOKIE_DOMAIN,
    path: '/',
    // maxAge is applied after expires and recomputes it per session
    expires: new Date(Date.now() + SESSION_MAX_AGE),
    maxAge: SESSION_MAX_AGE
  }
}));

app.use(csrf());

function layout(title, body, user) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
  nav{display:flex;gap:1rem;margin-bottom:1.5rem;border-bottom:1px solid #ccc;padding-bottom:.5rem}
  .msg{border:1px solid #ddd;border-radius:8px;padding:.75rem;margin:.5rem 0}
  .msg .author{font-weight:bold;color:#2a5}
  input,textarea{width:100%;padding:.5rem;margin:.25rem 0;box-sizing:border-box}
  button{padding:.5rem 1rem;cursor:pointer}
  .warn{background:#fee;border:1px solid #c33;padding:.5rem;border-radius:6px}
</style></head><body>
<nav>
  <a href="/">Forum</a>
  <a href="/search">Recherche</a>
  ${user ? `<span>Connecté : <b>${escapeHtml(user.username)}</b></span> <a href="/logout">Déconnexion</a>`
         : `<a href="/login">Connexion</a>`}
</nav>
${body}
</body></html>`;
}

app.get('/', (req, res) => {
  db.query('SELECT m.id, m.author, m.content, m.created_at FROM messages m ORDER BY m.id DESC',
    (err, rows) => {
      if (err) return dbError(res, err);
      const list = rows.map(r =>
        `<div class="msg"><span class="author">${escapeHtml(r.author)}</span>
         <small>${escapeHtml(r.created_at)}</small><p>${escapeHtml(r.content)}</p></div>`).join('');
      const form = req.session.user
        ? `<form method="POST" action="/post">
             <input type="hidden" name="_csrf" value="${req.csrfToken()}">
             <textarea name="content" rows="3" placeholder="Votre message..."></textarea>
             <button type="submit">Publier</button>
           </form>`
        : `<p class="warn">Connectez-vous pour publier un message.</p>`;
      res.send(layout('Forum', `<h1>Forum</h1>${form}<hr>${list}`, req.session.user));
    });
});

app.post('/post', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const author = req.session.user.username;
  const content = req.body.content || '';
  const sql = 'INSERT INTO messages (author, content) VALUES (?, ?)';
  db.query(sql, [author, content], (err) => {
    if (err) return dbError(res, err);
    res.redirect('/');
  });
});

app.get('/login', (req, res) => {
  res.send(layout('Connexion', `
    <h1>Connexion</h1>
    <form method="POST" action="/login">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}">
      <input name="username" placeholder="Identifiant" autocomplete="off">
      <input name="password" type="password" placeholder="Mot de passe">
      <button type="submit">Se connecter</button>
    </form>`, req.session.user));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username === HARDCODED_ADMIN.username && password === HARDCODED_ADMIN.password) {
    req.session.user = { username, role: 'admin' };
    return res.redirect('/');
  }

  // Requête paramétrée : les entrées ne sont jamais interprétées comme du SQL
  const sql = 'SELECT username, role FROM users WHERE username = ? AND password = ?';
  db.query(sql, [String(username || ''), String(password || '')], (err, rows) => {
    if (err) return dbError(res, err);
    if (rows.length > 0) {
      req.session.user = { username: rows[0].username, role: rows[0].role };
      return res.redirect('/');
    }
    res.send(layout('Connexion', '<p class="warn">Identifiants invalides.</p><a href="/login">Réessayer</a>', null));
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/search', (req, res) => {
  // ?q=a&q=b donne un tableau, que mysql2 développerait en liste de valeurs
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  let results = '';
  if (q !== undefined) {
    // % et _ cherchés tels quels, pas comme jokers
    const sql = "SELECT author, content FROM messages WHERE content LIKE CONCAT('%', ?, '%')";
    return db.query(sql, [q.replace(/[\\%_]/g, '\\$&')], (err, rows) => {
      if (err) return dbError(res, err);
      results = rows.map(r =>
        `<div class="msg"><span class="author">${escapeHtml(r.author)}</span><p>${escapeHtml(r.content)}</p></div>`).join('')
        || '<p>Aucun résultat.</p>';
      res.send(layout('Recherche', `
        <h1>Recherche</h1>
        <form method="GET"><input name="q" value="${escapeHtml(q)}" placeholder="Rechercher..."><button>OK</button></form>
        <hr>${results}`, req.session.user));
    });
  }
  res.send(layout('Recherche', `
    <h1>Recherche</h1>
    <form method="GET"><input name="q" placeholder="Rechercher..."><button>OK</button></form>`,
    req.session.user));
});

// HTTPS obligatoire : le cookie de session est secure, il n'est jamais envoyé en HTTP
const TLS_DIR = process.env.TLS_DIR || '/run/tls';
const tls = {
  key: fs.readFileSync(TLS_DIR + '/key.pem'),
  cert: fs.readFileSync(TLS_DIR + '/cert.pem')
};

const PORT = process.env.PORT || 3443;
https.createServer(tls, app).listen(PORT, () => console.log('Forum (vulnérable) démarré en HTTPS sur le port ' + PORT));
