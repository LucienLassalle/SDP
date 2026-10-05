CREATE DATABASE IF NOT EXISTS forum;
USE forum;

CREATE TABLE IF NOT EXISTS users (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role     VARCHAR(20) DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  author     VARCHAR(50) NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (username, password, role) VALUES
  ('alice',   'password1',   'user'),
  ('bob',     'qwerty',      'user'),
  ('charlie', 'letmein',     'user'),
  ('root',    'toor',        'admin');

INSERT INTO messages (author, content) VALUES
  ('alice',   'Bienvenue sur le forum du TP sécurité !'),
  ('bob',     'Quelqu''un a testé la page de recherche ?'),
  ('charlie', 'Pensez à bien documenter les failles trouvées.');
