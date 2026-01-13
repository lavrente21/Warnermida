const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// 1. CONFIGURAÇÃO DO CORS (PRONTA PARA FUNCIONAR)
app.use(cors()); // Permite qualquer origem para evitar bloqueios no Netlify
app.use(express.json());

// 2. CONEXÃO COM O BANCO DE DADOS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Teste de conexão nos Logs do Render
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Erro ao conectar no Banco:', err.stack);
  }
  console.log('✅ Conexão com PostgreSQL estabelecida!');
  release();
});

// 3. ROTA DE STATUS (Para testar se o servidor está vivo)
app.get('/api/status', (req, res) => {
    res.json({ mensagem: "Servidor online e operante!" });
});

// 4. ROTA DE REGISTRO
app.post('/api/registrar', async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, saldo) VALUES ($1, $2, $3, 0) RETURNING id',
      [nome, email, senha]
    );
    res.status(201).json({ message: "Usuário criado!", id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Este email já está cadastrado." });
  }
});

// 5. ROTA DE LOGIN
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1 AND senha = $2', [email, senha]);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(401).json({ error: "Email ou senha incorretos." });
    }
  } catch (err) {
    res.status(500).json({ error: "Erro interno no servidor." });
  }
});

// 6. INICIAR SERVIDOR
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
