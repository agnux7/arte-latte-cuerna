// Tabla de puntos de "La Vaca Barista".
// GET  /api/puntos            -> top 10
// POST /api/puntos {apodo, puntos, nivel} -> guarda el mejor puntaje del apodo y regresa el top 10 y su lugar
// Usa la API REST de Upstash Redis (variables que agrega la integración de Vercel).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CIERRE = new Date('2026-11-03T00:00:00-06:00').getTime(); // se congela al terminar el 2 de noviembre
const K = { top: 'vb:top', nombre: 'vb:nombre', nivel: 'vb:nivel' };

// Mismos niveles que el juego: filas x columnas. Sirve para calcular un tope de puntos por nivel.
const NIVELES = [[2, 5], [2, 6], [3, 6], [3, 7], [4, 7], [4, 8], [4, 8], [5, 8], [5, 9], [4, 8]];
function tope(nivel) {
  let max = 0;
  for (let l = 1; l <= nivel; l++) {
    const [f, c] = NIVELES[l - 1];
    max += f * c * 50 * (1 + (l - 1) * 0.25) + 100 * l + 5 * 50;
  }
  return Math.ceil(max + (nivel === 10 ? 2000 : 0));
}

const GROSERIAS = ['puta', 'puto', 'verga', 'pendej', 'chinga', 'culer', 'mierda', 'pinche', 'joto', 'maric', 'culo', 'coger',
  'cogid', 'pito', 'panocha', 'nalga', 'cabron', 'zorra', 'mamon', 'ojete', 'naco', 'nazi', 'hitler', 'fuck', 'shit', 'bitch', 'dick', 'cock', 'pussy', 'nigg'];
function limpia(apodo) {
  const n = String(apodo || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 16) return null;
  if (!/^[\p{L}\p{N} ._\-]+$/u.test(n)) return null;
  const plano = n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
  if (GROSERIAS.some((g) => plano.includes(g))) return null;
  return n;
}
const clave = (n) => n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

async function redis(...cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map((x) => x.result);
}

async function top10() {
  const [raw] = await redis(['ZREVRANGE', K.top, 0, 9, 'WITHSCORES']);
  const ids = [];
  for (let i = 0; i < raw.length; i += 2) ids.push([raw[i], Number(raw[i + 1])]);
  if (!ids.length) return [];
  const [nombres, niveles] = await redis(['HMGET', K.nombre, ...ids.map((x) => x[0])], ['HMGET', K.nivel, ...ids.map((x) => x[0])]);
  return ids.map((x, i) => ({ apodo: nombres[i] || x[0], puntos: x[1], nivel: Number(niveles[i]) || 1 }));
}

function leerCuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'La tabla no está configurada.' });
  const cerrada = Date.now() > CIERRE;
  try {
    if (req.method === 'GET') return res.status(200).json({ top: await top10(), cerrada });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });
    if (cerrada) return res.status(403).json({ error: 'La tabla ya cerró.', cerrada });

    const b = leerCuerpo(req);
    const apodo = limpia(b.apodo);
    const puntos = Number(b.puntos), nivel = Number(b.nivel);
    if (!apodo) return res.status(400).json({ error: 'Usa un apodo de 2 a 16 letras o números, sin groserías.' });
    if (!Number.isInteger(nivel) || nivel < 1 || nivel > 10 || !Number.isInteger(puntos) || puntos < 1 || puntos > tope(nivel)) {
      return res.status(400).json({ error: 'Ese puntaje no es válido.' });
    }

    // Un envío cada 15 segundos por IP.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    const [ok] = await redis(['SET', 'vb:ip:' + ip, '1', 'NX', 'EX', 15]);
    if (ok !== 'OK') return res.status(429).json({ error: 'Espera unos segundos antes de guardar otra vez.' });

    const id = clave(apodo);
    // GT: solo se queda el mejor puntaje de cada apodo. CH: regresa 1 si es nuevo o si mejoró.
    const [cambio] = await redis(['ZADD', K.top, 'GT', 'CH', puntos, id]);
    if (cambio) await redis(['HSET', K.nombre, id, apodo], ['HSET', K.nivel, id, nivel]);
    const [rank, total, mejor] = await redis(['ZREVRANK', K.top, id], ['ZCARD', K.top], ['ZSCORE', K.top, id]);
    return res.status(200).json({ top: await top10(), lugar: rank + 1, total, mejor: Number(mejor), nuevo: !!cambio, apodo });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo conectar con la tabla.' });
  }
};
