const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: 'https://warnermedia.netlify.app'
}));app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Rota de Registro
app.post('/api/registrar', async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, saldo) VALUES ($1, $2, $3, 0) RETURNING id',
      [nome, email, senha]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(400).json({ error: "Email já existe" });
  }
});

// Rota de Login
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  const result = await pool.query('SELECT * FROM usuarios WHERE email = $1 AND senha = $2', [email, senha]);
  if (result.rows.length > 0) res.json(result.rows[0]);
  else res.status(401).json({ error: "Credenciais inválidas" });
});

app.listen(process.env.PORT || 10000);