const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql');

const app = express();

const DB_CONFIG = {
  host: process.env.DB_HOST || 'db',
  user: 'root',
  password: 'root_password_123',
  database: 'forum'
};

const HARDCODED_ADMIN = { username: 'admin', password: 'admin123' };

const db = mysql.createPool(DB_CONFIG);

app.use(bodyParser.urlencoded({ extended: false }));

app.use(session({
  secret: 'super-secret-cle-en-dur',
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: false, secure: false }
}));

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
  ${user ? `<span>Connecté : <b>${user.username}</b></span> <a href="/logout">Déconnexion</a>`
         : `<a href="/login">Connexion</a>`}
</nav>
${body}
</body></html>`;
}

app.get('/', (req, res) => {
  db.query('SELECT m.id, m.author, m.content, m.created_at FROM messages m ORDER BY m.id DESC',
    (err, rows) => {
      if (err) return res.status(500).send('Erreur BDD : ' + err.message);
      const list = rows.map(r =>
        `<div class="msg"><span class="author">${r.author}</span>
         <small>${r.created_at}</small><p>${r.content}</p></div>`).join('');
      const form = req.session.user
        ? `<form method="POST" action="/post">
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
  const sql = `INSERT INTO messages (author, content) VALUES ('${author}', '${content}')`;
  db.query(sql, (err) => {
    if (err) return res.status(500).send('Erreur BDD : ' + err.message);
    res.redirect('/');
  });
});

app.get('/login', (req, res) => {
  res.send(layout('Connexion', `
    <h1>Connexion</h1>
    <form method="POST" action="/login">
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

  const sql = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).send('Erreur BDD : ' + err.message);
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
  const q = req.query.q;
  let results = '';
  if (q !== undefined) {
    const sql = `SELECT author, content FROM messages WHERE content LIKE '%${q}%'`;
    return db.query(sql, (err, rows) => {
      if (err) return res.status(500).send('Erreur BDD : ' + err.message);
      results = rows.map(r =>
        `<div class="msg"><span class="author">${r.author}</span><p>${r.content}</p></div>`).join('')
        || '<p>Aucun résultat.</p>';
      res.send(layout('Recherche', `
        <h1>Recherche</h1>
        <form method="GET"><input name="q" value="${q}" placeholder="Rechercher..."><button>OK</button></form>
        <hr>${results}`, req.session.user));
    });
  }
  res.send(layout('Recherche', `
    <h1>Recherche</h1>
    <form method="GET"><input name="q" placeholder="Rechercher..."><button>OK</button></form>`,
    req.session.user));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Forum (vulnérable) démarré sur le port ' + PORT));
