const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// Configuração do CORS - Aceita o seu site oficial
app.use(cors({
    origin: 'https://warnermidia.netlify.app',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Conexão com o Banco de Dados
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Teste de conexão (aparece nos logs do Render)
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Erro de conexão ao DB:', err.stack);
  }
  console.log('✅ Conectado ao PostgreSQL com sucesso!');
  release();
});

// Rota de Registro
app.post('/api/registrar', async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, saldo) VALUES ($1, $2, $3, 0) RETURNING id',
      [nome, email, senha]
    );
    res.status(201).json({ message: "Sucesso", id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Email já existe" });
  }
});

// Rota de Login
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1 AND senha = $2', [email, senha]);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(401).json({ error: "Credenciais inválidas" });
    }
  } catch (err) {
    res.status(500).json({ error: "Erro no servidor" });
  }
});

// Rota de Status (para você testar se a API está viva pelo navegador)
app.get('/api/status', (req, res) => {
  res.json({ status: "Operacional" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
