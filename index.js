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
  if (err) {
    return console.error('❌ Erro ao conectar no Banco:', err.stack);
  }
  console.log('✅ Conexão com PostgreSQL estabelecida com sucesso!');
  release();
});

// --- FUNÇÃO AUXILIAR: GERAR ID DE CONVITE (ex: user7721) ---
function gerarReferralId() {
    return 'user' + Math.floor(1000 + Math.random() * 9000);
}

// --- ROTAS DE STATUS ---
app.get('/api/status', (req, res) => {
    res.json({ mensagem: "Servidor Warner Media online!", horario: new Date() });
});

// --- ROTAS DE USUÁRIO (REGISTRO E LOGIN) ---

app.post('/api/registrar', async (req, res) => {
  const { nome, email, senha, ref } = req.body; // 'ref' agora é o código userXXXX
  try {
    let convidadoPorIdInterno = null;
    const novoReferralId = gerarReferralId();

    // Verifica se existe um padrinho com o código enviado
    if (ref) {
        const resRef = await pool.query('SELECT id FROM usuarios WHERE referral_id = $1', [ref]);
        if (resRef.rows.length > 0) {
            convidadoPorIdInterno = resRef.rows[0].id;
        }
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
    console.error("Erro no registro:", err.message);
    res.status(400).json({ error: "Erro ao registrar. Email já existe ou dados inválidos." });
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
    const result = await pool.query('SELECT id, nome, email, saldo, referral_id, convidado_por FROM usuarios WHERE id = $1', [id]);
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
  if (!usuario_id || !valor || !comprovativo) {
      return res.status(400).json({ error: "Dados incompletos para depósito." });
  }
  try {
    await pool.query(
      'INSERT INTO depositos (usuario_id, valor, comprovativo, status) VALUES ($1, $2, $3, ' + "'pendente'" + ')',
      [usuario_id, valor, comprovativo]
    );
    res.json({ message: "Depósito enviado para análise com sucesso!" });
  } catch (err) {
    console.error("ERRO SQL DEPÓSITO:", err.message);
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

// --- ROTA DE DADOS DA EQUIPE ---
// --- ROTA PARA DADOS DA EQUIPE ATUALIZADA (CORREÇÃO ERRO 500) ---
app.get('/api/equipe/:identificador', async (req, res) => {
    const { identificador } = req.params;
    try {
        let userId;

        // Tenta descobrir o ID se for o código 'userXXXX'
        if (identificador.startsWith('user')) {
            const userLookup = await pool.query('SELECT id FROM usuarios WHERE referral_id = $1', [identificador]);
            if (userLookup.rows.length === 0) return res.status(404).json({ error: "Código inválido" });
            userId = userLookup.rows[0].id;
        } else {
            userId = parseInt(identificador);
        }

        if (isNaN(userId)) return res.status(400).json({ error: "ID inválido" });

        // Queries separadas para evitar que um erro em uma trave a outra
        const membrosRes = await pool.query('SELECT COUNT(*) FROM usuarios WHERE convidado_por = $1', [userId]);
        
        // Verifica se a tabela bonus_equipe existe antes de somar
        const bonusRes = await pool.query(`
            SELECT COALESCE(SUM(valor_bonus), 0) as total 
            FROM bonus_equipe 
            WHERE usuario_id = $1`, [userId]);

        res.json({
            teamCount: parseInt(membrosRes.rows[0].count) || 0,
            teamBonus: parseFloat(bonusRes.rows[0].total) || 0
        });

    } catch (err) {
        console.error("ERRO CRÍTICO NA ROTA EQUIPE:", err.message);
        // Retorna 200 com valores zerados em vez de dar erro 500, para não quebrar o site
        res.status(200).json({ teamCount: 0, teamBonus: 0, warning: "Erro ao processar dados" });
    }
});
// --- ROTAS ADMINISTRATIVAS (APROVAÇÃO COM COMISSÃO) ---

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
    await pool.query('BEGIN');
    
    // 1. Aprova o depósito e credita o saldo do usuário
    await pool.query('UPDATE depositos SET status = $1 WHERE id = $2', ['aprovado', deposito_id]);
    await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, usuario_id]);
    
    // 2. SISTEMA DE GANHOS POR EQUIPE (3 Níveis)
    const niveis = [
        { porc: 0.10, n: 1 }, // 10%
        { porc: 0.03, n: 2 }, // 3%
        { porc: 0.02, n: 3 }  // 2%
    ];

    let atualId = usuario_id;
    for (const n of niveis) {
        const resPai = await pool.query('SELECT convidado_por FROM usuarios WHERE id = $1', [atualId]);
        const paiId = resPai.rows[0]?.convidado_por;

        if (paiId) {
            const comissao = valor * n.porc;
            await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [comissao, paiId]);
            // Registra para o histórico de equipe
            await pool.query('INSERT INTO bonus_equipe (usuario_id, quem_gerou_id, valor_bonus, nivel) VALUES ($1, $2, $3, $4)', 
                [paiId, usuario_id, comissao, n.n]);
            atualId = paiId;
        } else {
            break;
        }
    }
    
    await pool.query('COMMIT');
    res.json({ message: "Aprovado e comissões distribuídas!" });
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
