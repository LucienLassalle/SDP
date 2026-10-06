-- Le client mysql de l'image lit ce fichier en latin1 par défaut
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS forum;
-- Déjà créée en latin1 par MYSQL_DATABASE : on force l'encodage
ALTER DATABASE forum CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE forum;

-- Compte de l'application (créé par MYSQL_USER) : lecture et ajout seulement
REVOKE ALL PRIVILEGES ON forum.* FROM 'forum'@'%';
GRANT SELECT, INSERT ON forum.* TO 'forum'@'%';

CREATE TABLE IF NOT EXISTS users (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role     VARCHAR(20) DEFAULT 'user'
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  author     VARCHAR(50) NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO users (username, password, role) VALUES
  ('alice',   'password1',   'user'),
  ('bob',     'qwerty',      'user'),
  ('charlie', 'letmein',     'user'),
  ('root',    'toor',        'admin');

INSERT INTO messages (author, content) VALUES
  ('alice',   'Bienvenue sur le forum du TP sécurité !'),
  ('bob',     'Quelqu''un a testé la page de recherche ?'),
  ('charlie', 'Pensez à bien documenter les failles trouvées.');
