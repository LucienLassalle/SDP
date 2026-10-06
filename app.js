const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const Tokens = require('csrf');

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

const db = mysql.createPool(DB_CONFIG);
const dbp = db.promise();

// scrypt de Node (aucune dépendance) avec des paramètres recommandés par l'OWASP : 32 Mio, p=3
const SCRYPT = { N: 2 ** 15, r: 8, p: 3 };
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, { N, r, p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))));
}

// Format stocké : scrypt$N$r$p$sel$hash (base64), pour pouvoir changer les paramètres plus tard
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,50}$/;
const PASSWORD_MIN_LENGTH = 12;
// Borne le coût de scrypt sur des entrées géantes
const PASSWORD_MAX_LENGTH = 256;

function passwordProblem(password, confirm) {
  if (password.length < PASSWORD_MIN_LENGTH) return `Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Le mot de passe doit faire au plus ${PASSWORD_MAX_LENGTH} caractères.`;
  if (password !== confirm) return 'Les mots de passe ne correspondent pas.';
  return null;
}

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

const tokens = new Tokens();
const CSRF_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// Secret kept in the session; forms send a token derived from it in the hidden _csrf field
app.use((req, res, next) => {
  if (!req.session.csrfSecret) req.session.csrfSecret = tokens.secretSync();
  req.csrfToken = () => tokens.create(req.session.csrfSecret);
  if (CSRF_SAFE_METHODS.includes(req.method)) return next();
  if (!tokens.verify(req.session.csrfSecret, req.body?._csrf)) {
    return res.status(403).send('Jeton CSRF invalide');
  }
  next();
});

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
  ${user ? `<span>Connecté : <b>${escapeHtml(user.username)}</b></span> <a href="/password">Mot de passe</a> <a href="/logout">Déconnexion</a>`
         : `<a href="/login">Connexion</a> <a href="/register">Créer un compte</a>`}
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

// Nouvelle session à chaque connexion : un identifiant de session fixé avant n'est pas réutilisable
function logIn(req, res, user) {
  req.session.regenerate((err) => {
    if (err) return dbError(res, err);
    req.session.user = { username: user.username, role: user.role };
    res.redirect('/');
  });
}

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '').slice(0, PASSWORD_MAX_LENGTH);
  try {
    // Requête paramétrée : les entrées ne sont jamais interprétées comme du SQL
    const [rows] = await dbp.query('SELECT username, password, role FROM users WHERE username = ?', [username]);
    // Hash calculé même pour un compte inconnu : le temps de réponse ne révèle pas s'il existe
    const valid = rows.length > 0
      ? await verifyPassword(password, rows[0].password)
      : (await hashPassword(password), false);
    if (valid) return logIn(req, res, rows[0]);
    res.send(layout('Connexion', '<p class="warn">Identifiants invalides.</p><a href="/login">Réessayer</a>', null));
  } catch (err) {
    dbError(res, err);
  }
});

function registerPage(req, error) {
  return layout('Créer un compte', `
    <h1>Créer un compte</h1>
    ${error ? `<p class="warn">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="/register">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}">
      <input name="username" placeholder="Identifiant (3 à 50 caractères : lettres, chiffres, . _ -)" autocomplete="username">
      <input name="password" type="password" placeholder="Mot de passe (${PASSWORD_MIN_LENGTH} caractères minimum)" autocomplete="new-password">
      <input name="confirm" type="password" placeholder="Confirmer le mot de passe" autocomplete="new-password">
      <button type="submit">Créer le compte</button>
    </form>`, req.session.user);
}

app.get('/register', (req, res) => {
  res.send(registerPage(req));
});

app.post('/register', async (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  const problem = USERNAME_PATTERN.test(username)
    ? passwordProblem(password, String(req.body.confirm || ''))
    : 'Identifiant invalide : 3 à 50 caractères parmi lettres, chiffres, . _ -';
  if (problem) return res.status(400).send(registerPage(req, problem));
  try {
    const user = { username, role: 'user' };
    await dbp.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, await hashPassword(password), user.role]);
    logIn(req, res, user);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).send(registerPage(req, 'Cet identifiant est déjà utilisé.'));
    dbError(res, err);
  }
});

function passwordPage(req, error, done) {
  return layout('Mot de passe', `
    <h1>Changer de mot de passe</h1>
    ${error ? `<p class="warn">${escapeHtml(error)}</p>` : ''}
    ${done ? '<p>Mot de passe modifié.</p>' : ''}
    <form method="POST" action="/password">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}">
      <input name="current" type="password" placeholder="Mot de passe actuel" autocomplete="current-password">
      <input name="password" type="password" placeholder="Nouveau mot de passe (${PASSWORD_MIN_LENGTH} caractères minimum)" autocomplete="new-password">
      <input name="confirm" type="password" placeholder="Confirmer le nouveau mot de passe" autocomplete="new-password">
      <button type="submit">Changer</button>
    </form>`, req.session.user);
}

app.get('/password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.send(passwordPage(req));
});

app.post('/password', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { username } = req.session.user;
  const current = String(req.body.current || '').slice(0, PASSWORD_MAX_LENGTH);
  const password = String(req.body.password || '');
  try {
    const [rows] = await dbp.query('SELECT password FROM users WHERE username = ?', [username]);
    if (rows.length === 0 || !(await verifyPassword(current, rows[0].password))) {
      return res.status(403).send(passwordPage(req, 'Mot de passe actuel incorrect.'));
    }
    const problem = passwordProblem(password, String(req.body.confirm || ''));
    if (problem) return res.status(400).send(passwordPage(req, problem));
    await dbp.query('UPDATE users SET password = ? WHERE username = ?', [await hashPassword(password), username]);
    res.send(passwordPage(req, null, true));
  } catch (err) {
    dbError(res, err);
  }
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
    // No return of db.query: Express 5 would treat the mysql2 Query (thenable) as a promise
    db.query(sql, [q.replace(/[\\%_]/g, '\\$&')], (err, rows) => {
      if (err) return dbError(res, err);
      results = rows.map(r =>
        `<div class="msg"><span class="author">${escapeHtml(r.author)}</span><p>${escapeHtml(r.content)}</p></div>`).join('')
        || '<p>Aucun résultat.</p>';
      res.send(layout('Recherche', `
        <h1>Recherche</h1>
        <form method="GET"><input name="q" value="${escapeHtml(q)}" placeholder="Rechercher..."><button>OK</button></form>
        <hr>${results}`, req.session.user));
    });
    return;
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

// Aucun compte en base : création d'un admin au mot de passe aléatoire, affiché une seule fois dans les logs
async function createAdminIfNoAccount() {
  const [[{ count }]] = await dbp.query('SELECT COUNT(*) AS count FROM users');
  if (count > 0) return;
  const password = crypto.randomBytes(18).toString('base64url');
  try {
    await dbp.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      ['admin', await hashPassword(password), 'admin']);
  } catch (err) {
    // Une autre instance l'a créé en même temps
    if (err.code === 'ER_DUP_ENTRY') return;
    throw err;
  }
  console.log([
    'Aucun compte existant : compte administrateur créé.',
    '  Identifiant  : admin',
    `  Mot de passe : ${password}`,
    "Il n'est affiché qu'une fois : changez-le après la première connexion (/password)."
  ].join('\n'));
}

const PORT = process.env.PORT || 3443;
createAdminIfNoAccount()
  .then(() => https.createServer(tls, app).listen(PORT, () => console.log('Forum démarré en HTTPS sur le port ' + PORT)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
