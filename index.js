const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// --- CONFIGURAÇÕES DE MIDDLEWARE ---
app.use(cors()); // Permite que o site no Netlify acesse o servidor no Render
app.use(express.json({ limit: '10mb' })); // Aceita JSONs maiores (importante para URLs longas)
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// --- CONEXÃO COM O BANCO DE DADOS POSTGRESQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Teste de conexão imediato
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Erro ao conectar no Banco:', err.stack);
  }
  console.log('✅ Conexão com PostgreSQL estabelecida com sucesso!');
  release();
});

// --- ROTAS DE STATUS ---
app.get('/api/status', (req, res) => {
    res.json({ mensagem: "Servidor Warner Media online!", horario: new Date() });
});

// --- ROTAS DE USUÁRIO (REGISTRO E LOGIN) ---

app.post('/api/registrar', async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, saldo) VALUES ($1, $2, $3, 0) RETURNING id',
      [nome, email, senha]
    );
    res.status(201).json({ message: "Usuário criado!", id: result.rows[0].id });
  } catch (err) {
    console.error("Erro no registro:", err.message);
    res.status(400).json({ error: "Este email já está cadastrado ou dados inválidos." });
  }
});

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
    console.error("Erro no login:", err.message);
    res.status(500).json({ error: "Erro interno no servidor." });
  }
});

app.get('/api/usuario/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT id, nome, email, saldo FROM usuarios WHERE id = $1', [id]);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: "Usuário não encontrado" });
    }
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar dados do usuário" });
  }
});

// --- ROTA DE DEPÓSITO (ENVIO DO COMPROVATIVO) ---

app.post('/api/deposito', async (req, res) => {
  const { usuario_id, valor, comprovativo } = req.body;
  
  // Validação simples de backend
  if (!usuario_id || !valor || !comprovativo) {
      return res.status(400).json({ error: "Dados incompletos para depósito." });
  }

  try {
    await pool.query(
      'INSERT INTO depositos (usuario_id, valor, comprovativo, status) VALUES ($1, $2, $3, $4)',
      [usuario_id, valor, comprovativo, 'pendente']
    );
    res.json({ message: "Depósito enviado para análise com sucesso!" });
  } catch (err) {
    console.error("ERRO SQL DEPÓSITO:", err.message);
    res.status(500).json({ error: "Erro ao processar depósito no banco de dados." });
  }
});

// --- ROTA DE TAREFAS ---

app.post('/api/completar-tarefa', async (req, res) => {
    const { usuario_id, valor } = req.body;
    try {
        await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, usuario_id]);
        res.json({ message: "Tarefa recompensada!" });
    } catch (err) {
        res.status(500).json({ error: "Erro ao processar recompensa." });
    }
});

// --- ROTAS ADMINISTRATIVAS (APROVAÇÃO) ---

app.get('/api/admin/depositos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, u.nome, u.email 
      FROM depositos d 
      JOIN usuarios u ON d.usuario_id = u.id 
      WHERE d.status = 'pendente'
      ORDER BY d.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar depósitos pendentes." });
  }
});

app.post('/api/admin/aprovar', async (req, res) => {
  const { deposito_id, usuario_id, valor } = req.body;
  
  try {
    // Inicia uma transação (garante que ou faz tudo ou não faz nada)
    await pool.query('BEGIN');
    
    // 1. Atualiza o status do depósito
    await pool.query('UPDATE depositos SET status = $1 WHERE id = $2', ['aprovado', deposito_id]);
    
    // 2. Adiciona o saldo ao usuário
    await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, usuario_id]);
    
    await pool.query('COMMIT');
    res.json({ message: "Depósito aprovado e saldo creditado!" });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("Erro na aprovação:", err.message);
    res.status(500).json({ error: "Erro ao aprovar depósito." });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Warner Media Server rodando na porta ${PORT}`);
});
