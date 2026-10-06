const constants = require('constants');
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const Tokens = require('csrf');
const { hashPassword, verifyPassword, randomPassword } = require('./passwords');

const app = express();

// Pages rendues par EJS : <%= %> échappe toute valeur insérée dans le HTML (texte ou attribut)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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
  res.locals.csrfToken = req.csrfToken;
  if (CSRF_SAFE_METHODS.includes(req.method)) return next();
  if (!tokens.verify(req.session.csrfSecret, req.body?._csrf)) {
    return res.status(403).send('Jeton CSRF invalide');
  }
  next();
});

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.passwordMinLength = PASSWORD_MIN_LENGTH;
  next();
});

app.get('/', (req, res) => {
  db.query('SELECT m.id, m.author, m.content, m.created_at FROM messages m ORDER BY m.id DESC',
    (err, rows) => {
      if (err) return dbError(res, err);
      res.render('index', { messages: rows });
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
  res.render('login');
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
    res.render('login', { failed: true, user: null });
  } catch (err) {
    dbError(res, err);
  }
});

app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', async (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  const problem = USERNAME_PATTERN.test(username)
    ? passwordProblem(password, String(req.body.confirm || ''))
    : 'Identifiant invalide : 3 à 50 caractères parmi lettres, chiffres, . _ -';
  if (problem) return res.status(400).render('register', { error: problem });
  try {
    const user = { username, role: 'user' };
    await dbp.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, await hashPassword(password), user.role]);
    logIn(req, res, user);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).render('register', { error: 'Cet identifiant est déjà utilisé.' });
    dbError(res, err);
  }
});

app.get('/password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('password');
});

app.post('/password', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { username } = req.session.user;
  const current = String(req.body.current || '').slice(0, PASSWORD_MAX_LENGTH);
  const password = String(req.body.password || '');
  try {
    const [rows] = await dbp.query('SELECT password FROM users WHERE username = ?', [username]);
    if (rows.length === 0 || !(await verifyPassword(current, rows[0].password))) {
      return res.status(403).render('password', { error: 'Mot de passe actuel incorrect.' });
    }
    const problem = passwordProblem(password, String(req.body.confirm || ''));
    if (problem) return res.status(400).render('password', { error: problem });
    await dbp.query('UPDATE users SET password = ? WHERE username = ?', [await hashPassword(password), username]);
    res.render('password', { done: true });
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
  if (q === undefined) return res.render('search');
  // % et _ cherchés tels quels, pas comme jokers
  const sql = "SELECT author, content FROM messages WHERE content LIKE CONCAT('%', ?, '%')";
  // No return of db.query: Express 5 would treat the mysql2 Query (thenable) as a promise
  db.query(sql, [q.replace(/[\\%_]/g, '\\$&')], (err, rows) => {
    if (err) return dbError(res, err);
    res.render('search', { q, results: rows });
  });
});

// HTTPS obligatoire : le cookie de session est secure, il n'est jamais envoyé en HTTP
const TLS_DIR = process.env.TLS_DIR || '/run/tls';
const tlsKey = fs.readFileSync(TLS_DIR + '/key.pem');
const tlsCert = fs.readFileSync(TLS_DIR + '/cert.pem');

// Aucun compte en base : création d'un admin au mot de passe aléatoire, affiché une seule fois dans les logs
async function createAdminIfNoAccount() {
  const [[{ count }]] = await dbp.query('SELECT COUNT(*) AS count FROM users');
  if (count > 0) return;
  const password = randomPassword();
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

function startServer() {
  https.createServer({
    key: tlsKey,
    cert: tlsCert,
    // TLS 1.2 minimum, même si NODE_OPTIONS abaisse celui de Node ; SSL v2/v3 et TLS 1.0 coupés aussi côté OpenSSL
    minVersion: 'TLSv1.2',
    secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1
  }, app).listen(PORT, () => console.log('Forum démarré en HTTPS sur le port ' + PORT));
}

createAdminIfNoAccount()
  .then(startServer)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
