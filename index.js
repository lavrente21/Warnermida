const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// --- CONFIGURAÇÕES DE MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// --- CONEXÃO COM O BANCO DE DADOS POSTGRESQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) return console.error('❌ Erro ao conectar no Banco:', err.stack);
  console.log('✅ Conexão com PostgreSQL estabelecida com sucesso!');
  release();
});

// --- FUNÇÃO AUXILIAR: GERAR ID DE CONVITE ---
function gerarReferralId() {
    return 'user' + Math.floor(1000 + Math.random() * 9000);
}

// --- ROTAS DE STATUS ---
app.get('/api/status', (req, res) => {
    res.json({ mensagem: "Servidor Warner Media online!", horario: new Date() });
});

// --- ROTAS DE USUÁRIO (REGISTRO E LOGIN) ---

app.post('/api/registrar', async (req, res) => {
  const { nome, email, senha, ref } = req.body;
  try {
    let convidadoPorIdInterno = null;
    const novoReferralId = gerarReferralId();

    if (ref) {
        const resRef = await pool.query('SELECT id FROM usuarios WHERE referral_id = $1', [ref]);
        if (resRef.rows.length > 0) convidadoPorIdInterno = resRef.rows[0].id;
    }

    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, saldo, referral_id, convidado_por) VALUES ($1, $2, $3, 0, $4, $5) RETURNING id, referral_id',
      [nome, email, senha, novoReferralId, convidadoPorIdInterno]
    );
    res.status(201).json({ 
        message: "Usuário criado!", 
        id: result.rows[0].id, 
        referral_id: result.rows[0].referral_id 
    });
  } catch (err) {
    res.status(400).json({ error: "Erro ao registrar. Email já existe." });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1 AND senha = $2', [email, senha]);
    if (result.rows.length > 0) res.json(result.rows[0]);
    else res.status(401).json({ error: "Email ou senha incorretos." });
  } catch (err) {
    res.status(500).json({ error: "Erro interno no servidor." });
  }
});

app.get('/api/usuario/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT id, nome, email, saldo, referral_id, convidado_por FROM usuarios WHERE id = $1', [id]);
    if (result.rows.length > 0) res.json(result.rows[0]);
    else res.status(404).json({ error: "Usuário não encontrado" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar dados" });
  }
});

// --- ROTA DE DEPÓSITO (CLIENTE ENVIANDO COMPROVATIVO) ---

app.post('/api/deposito', async (req, res) => {
  const { usuario_id, valor, comprovativo } = req.body;
  if (!usuario_id || !valor || !comprovativo) return res.status(400).json({ error: "Dados incompletos." });
  try {
    await pool.query(
      'INSERT INTO depositos (usuario_id, valor, comprovativo, status) VALUES ($1, $2, $3, $4)',
      [usuario_id, valor, comprovativo, 'pendente']
    );
    res.json({ message: "Depósito enviado com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao processar depósito." });
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

// --- ROTA DE EQUIPE ---

app.get('/api/equipe/:identificador', async (req, res) => {
    const { identificador } = req.params;
    try {
        let userId;
        if (identificador.startsWith('user')) {
            const userLookup = await pool.query('SELECT id FROM usuarios WHERE referral_id = $1', [identificador]);
            if (userLookup.rows.length === 0) return res.status(404).json({ error: "Código inválido" });
            userId = userLookup.rows[0].id;
        } else {
            userId = parseInt(identificador);
        }

        const membrosRes = await pool.query('SELECT COUNT(*) FROM usuarios WHERE convidado_por = $1', [userId]);
        const bonusRes = await pool.query('SELECT COALESCE(SUM(valor_bonus), 0) as total FROM bonus_equipe WHERE usuario_id = $1', [userId]);

        res.json({
            teamCount: parseInt(membrosRes.rows[0].count) || 0,
            teamBonus: parseFloat(bonusRes.rows[0].total) || 0
        });
    } catch (err) {
        res.json({ teamCount: 0, teamBonus: 0 });
    }
});

// --- ROTAS ADMINISTRATIVAS (APROVAÇÃO COM COMISSÃO) ---

// Lista para o Admin
app.get('/api/admin/depositos-pendentes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, u.nome, u.email 
      FROM depositos d 
      JOIN usuarios u ON d.usuario_id = u.id 
      WHERE d.status = 'pendente' ORDER BY d.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar dados." });
  }
});

// Rota Final de Aprovação
app.post('/api/admin/processar-deposito', async (req, res) => {
  const { deposito_id, status } = req.body; // status: 'aprovado' ou 'rejeitado'
  
  try {
    await pool.query('BEGIN');

    const resDep = await pool.query('SELECT * FROM depositos WHERE id = $1', [deposito_id]);
    const deposito = resDep.rows[0];

    if (!deposito || deposito.status !== 'pendente') {
        await pool.query('ROLLBACK');
        return res.status(400).json({ error: "Depósito inválido" });
    }

    if (status === 'aprovado') {
        const valor = parseFloat(deposito.valor);
        const userId = deposito.usuario_id;

        // 1. Crédito ao usuário
        await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, userId]);

        // 2. SISTEMA MULTINÍVEL (10%, 3%, 2%)
        const porcentagens = [0.10, 0.03, 0.02];
        let atualId = userId;

        for (let i = 0; i < porcentagens.length; i++) {
            const resPai = await pool.query('SELECT convidado_por FROM usuarios WHERE id = $1', [atualId]);
            const paiId = resPai.rows[0]?.convidado_por;

            if (paiId) {
                const comissao = valor * porcentagens[i];
                await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [comissao, paiId]);
                await pool.query('INSERT INTO bonus_equipe (usuario_id, quem_gerou_id, valor_bonus, nivel) VALUES ($1, $2, $3, $4)', 
                    [paiId, userId, comissao, i + 1]);
                atualId = paiId;
            } else {
                break;
            }
        }
    }

    // Atualiza status do depósito
    await pool.query('UPDATE depositos SET status = $1 WHERE id = $2', [status, deposito_id]);
    
    await pool.query('COMMIT');
    res.json({ success: true });

  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: "Erro na transação." });
  }
});



// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Warner Media Server rodando na porta ${PORT}`);
});
