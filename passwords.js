const crypto = require('crypto');

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

// Mot de passe aléatoire de 24 caractères (144 bits), pour le compte admin créé au démarrage
function randomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

module.exports = { hashPassword, verifyPassword, randomPassword };
