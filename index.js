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

// --- ALTERE DE: app.post('/api/retirar' ---
// --- PARA: ---
app.post('/api/levantamento', async (req, res) => {
    const { usuario_id, valor, iban, nome_titular, senha } = req.body;
    try {
        // Verifica saldo e senha
        const userRes = await pool.query('SELECT saldo, senha FROM usuarios WHERE id = $1', [usuario_id]);
        const user = userRes.rows[0];

        if (!user || user.senha !== senha) return res.status(401).json({ error: "Senha incorreta" });
        if (parseFloat(user.saldo) < parseFloat(valor)) return res.status(400).json({ error: "Saldo insuficiente" });

        await pool.query('BEGIN');
        // Deduz saldo
        await pool.query('UPDATE usuarios SET saldo = saldo - $1 WHERE id = $2', [valor, usuario_id]);
        
        // Registra saque (Certifique-se que a tabela se chama 'saques' ou 'levantamentos')
        await pool.query(
            'INSERT INTO saques (usuario_id, valor, iban, nome_titular, status) VALUES ($1, $2, $3, $4, $5)',
            [usuario_id, valor, iban, nome_titular, 'pendente']
        );
        await pool.query('COMMIT');
        res.json({ success: true, message: "Levantamento solicitado!" });
    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Erro ao processar saque" });
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
    // ADICIONEI 'nivel_vip' ABAIXO:
    const result = await pool.query('SELECT id, nome, email, saldo, referral_id, convidado_por, nivel_vip FROM usuarios WHERE id = $1', [id]);
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

// --- COLOQUE ESTAS ROTAS LOGO ABAIXO DAS ROTAS DE DEPÓSITO NO SEU SERVER.JS ---
// --- ROTA PARA BUSCAR TAREFAS DISPONÍVEIS (CORREÇÃO) ---
// --- ROTA PARA BUSCAR TAREFAS DISPONÍVEIS .

app.get('/api/tarefas-disponiveis/:usuario_id', async (req, res) => {
    const { usuario_id } = req.params;
    try {
        // CORREÇÃO: Usando 'nivel_vip' em vez de 'vip_nivel'
        const userRes = await pool.query(
            `SELECT u.nivel_vip, v.qtd_tarefas 
             FROM usuarios u 
             LEFT JOIN planos_vip v ON u.nivel_vip = v.nivel 
             WHERE u.id = $1`, [usuario_id]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "Usuário não encontrado" });
        }

        const { nivel_vip, qtd_tarefas } = userRes.rows[0];
        const limiteDiario = qtd_tarefas || 0;

        // Contar tarefas feitas hoje
        const countRes = await pool.query(
            `SELECT COUNT(*) FROM historico_tarefas 
             WHERE usuario_id = $1 AND data::date = CURRENT_DATE`, [usuario_id]
        );
        const tarefasFeitasHoje = parseInt(countRes.rows[0].count);

        if (tarefasFeitasHoje >= limiteDiario) {
            return res.json([]); // Retorna lista vazia se atingiu o limite
        }

        // Buscar tarefas disponíveis para o nível do usuário
        const tarefasRes = await pool.query(
            `SELECT * FROM tarefas 
             WHERE nivel_minimo <= $1 
             AND id NOT IN (
                 SELECT tarefa_id FROM historico_tarefas 
                 WHERE usuario_id = $2 AND data::date = CURRENT_DATE
             )
             LIMIT $3`, [nivel_vip, usuario_id, (limiteDiario - tarefasFeitasHoje)]
        );

        res.json(tarefasRes.rows);
    } catch (err) {
        console.error("Erro detalhado:", err);
        res.status(500).json({ error: "Erro interno no servidor" });
    }
});

// Adicione isto antes de app.listen
app.post('/api/postback-cpagrip', async (req, res) => {
    const { user_id, valor } = req.body;
    try {
        await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, user_id]);
        res.json({ success: true, message: "Saldo atualizado via CPA!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro ao processar recompensa no banco." });
    }
});
// --- ROTA DE REGISTO ---
app.post('/api/registrar', async (req, res) => {
    const { nome, email, senha, convidado_por } = req.body;
    
    try {
        // 1. Gera um ID de convite único para o novo usuário
        const referral_id = 'user' + Math.floor(1000 + Math.random() * 9000);

        // 2. Insere o usuário na base de dados
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha, referral_id, convidado_por, saldo, nivel_vip) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [nome, email, senha, referral_id, convidado_por || null, 0, 0]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Erro no registo:", err);
        if (err.code === '23505') { // Código de erro para email duplicado no Postgres
            return res.status(400).json({ error: "Este email já está registado." });
        }
        res.status(500).json({ error: "Erro ao criar conta." });
    }
});

// 1. ROTA DE SOLICITAÇÃO DE SAQUE (Lado do Cliente)
app.post('/api/retirar', async (req, res) => {
    const { usuario_id, valor, iban, nome_titular, senha } = req.body;
    try {
        // Verifica saldo e senha
        const userRes = await pool.query('SELECT saldo, senha FROM usuarios WHERE id = $1', [usuario_id]);
        const user = userRes.rows[0];

        if (!user || user.senha !== senha) return res.status(401).json({ error: "Senha incorreta" });
        if (parseFloat(user.saldo) < parseFloat(valor)) return res.status(400).json({ error: "Saldo insuficiente" });

        await pool.query('BEGIN');
        // Deduz saldo
        await pool.query('UPDATE usuarios SET saldo = saldo - $1 WHERE id = $2', [valor, usuario_id]);
        // Registra saque
        await pool.query(
            'INSERT INTO saques (usuario_id, valor, iban, nome_titular, status) VALUES ($1, $2, $3, $4, $5)',
            [usuario_id, valor, iban, nome_titular, 'pendente']
        );
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: "Erro ao processar saque" });
    }
});

app.post('/api/admin/config-vip', async (req, res) => {
    const { nivel, nome, preco, qtd_tarefas, ganho_por_tarefa, ganho_total_mensal } = req.body;
    try {
        await pool.query(
            `INSERT INTO planos_vip (nivel, nome, preco, qtd_tarefas, ganho_por_tarefa, ganho_total_mensal) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             ON CONFLICT (nivel) DO UPDATE SET 
             nome=$2, preco=$3, qtd_tarefas=$4, ganho_por_tarefa=$5, ganho_total_mensal=$6`,
            [nivel, nome, preco, qtd_tarefas, ganho_por_tarefa, ganho_total_mensal]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Adicione esta rota no seu servidor para buscar o histórico de tarefas
// ROTA PARA BUSCAR HISTÓRICO DE TAREFAS CONCLUÍDAS
app.get('/api/historico/:usuario_id', async (req, res) => {
    const { usuario_id } = req.params;
    try {
        const result = await pool.query(`
            SELECT h.data, t.recompensa, t.nome as titulo
            FROM historico_tarefas h
            JOIN tarefas t ON h.tarefa_id = t.id
            WHERE h.usuario_id = $1
            ORDER BY h.data DESC
        `, [usuario_id]);
        
        res.json(result.rows);
    } catch (err) {
        console.error("Erro ao buscar histórico:", err);
        res.status(500).json({ error: "Erro ao carregar histórico no banco de dados." });
    }
});


// 2. ROTA QUE ESTAVA DANDO 404 (Lado do Admin)
app.get('/api/admin/saques-pendentes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, u.nome, u.email 
            FROM saques s 
            JOIN usuarios u ON s.usuario_id = u.id 
            WHERE s.status = 'pendente' 
            ORDER BY s.data DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Erro ao buscar saques" });
    }
});
// --- ROTA DE COMPRA DE VIP ---
app.post('/api/comprar-vip', async (req, res) => {
    const { usuario_id, nivel_vip } = req.body;
    try {
        // 1. Verificar se o usuário já possui esse VIP ativo
        const userCheck = await pool.query('SELECT nivel_vip, saldo FROM usuarios WHERE id = $1', [usuario_id]);
        if (userCheck.rows[0].nivel_vip === nivel_vip) {
            return res.status(400).json({ error: "Você já possui este plano VIP ativo!" });
        }

        const saldoAtual = userCheck.rows[0].saldo;

        // 2. Buscar o preço do novo VIP
        const vipRes = await pool.query('SELECT preco FROM planos_vip WHERE nivel = $1', [nivel_vip]);
        const preco = vipRes.rows[0].preco;

        if (saldoAtual < preco) {
            return res.status(400).json({ error: "Saldo insuficiente para adquirir este VIP." });
        }

        // 3. Processar a compra
        await pool.query('BEGIN');
        await pool.query('UPDATE usuarios SET saldo = saldo - $1, nivel_vip = $2 WHERE id = $3', [preco, nivel_vip, usuario_id]);
        await pool.query('COMMIT');

        res.json({ success: true, message: "VIP adquirido com sucesso!" });
    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        res.status(500).json({ error: "Erro ao processar compra." });
    }
});


// --- ROTA DE TAREFAS CORRIGIDA ---
app.post('/api/completar-tarefa', async (req, res) => {
    const { usuario_id, tarefa_id } = req.body;

    if (!usuario_id || !tarefa_id) {
        return res.status(400).json({ error: "Dados incompletos." });
    }

    try {
        await pool.query('BEGIN');

        // 1. Busca a recompensa
        const tarefaRes = await pool.query('SELECT recompensa FROM tarefas WHERE id = $1', [tarefa_id]);
        if (tarefaRes.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: "Tarefa não encontrada." });
        }
        const valor = tarefaRes.rows[0].recompensa;

        // 2. Registro no histórico - Use NOW() para garantir compatibilidade de Timestamp
        await pool.query(
            'INSERT INTO historico_tarefas (usuario_id, tarefa_id, data) VALUES ($1, $2, NOW())',
            [usuario_id, tarefa_id]
        );

        // 3. Atualiza o saldo
        await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, usuario_id]);

        await pool.query('COMMIT');
        res.json({ success: true, message: `Tarefa recompensada com ${valor} Kz!` });

    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error("Erro detalhado:", err.message); // Isso aparecerá no log do Render/Heroku
        res.status(500).json({ error: "Erro interno: verifique se a tabela 'historico_tarefas' existe." });
    }
});
// --- ROTA DE TAREFAS ---

app.post('/api/completar-tarefa', async (req, res) => {
    const { usuario_id, tarefa_id } = req.body;

    try {
        await pool.query('BEGIN');

        // 1. Verifica se o usuário já atingiu o limite diário antes de processar
        const userVip = await pool.query(
            `SELECT u.nivel_vip, v.qtd_tarefas 
             FROM usuarios u 
             LEFT JOIN planos_vip v ON u.nivel_vip = v.nivel 
             WHERE u.id = $1`, [usuario_id]);
        
        const limiteDiario = userVip.rows[0]?.qtd_tarefas || 0;

        const contagemHoje = await pool.query(
            `SELECT COUNT(*) FROM historico_tarefas 
             WHERE usuario_id = $1 AND data::date = CURRENT_DATE`, [usuario_id]);

        if (parseInt(contagemHoje.rows[0].count) >= limiteDiario) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: "Limite diário de tarefas atingido!" });
        }

        // 2. Busca a recompensa da tarefa
        const tarefaRes = await pool.query('SELECT recompensa FROM tarefas WHERE id = $1', [tarefa_id]);
        const valor = tarefaRes.rows[0].recompensa;

        // 3. Registra com a data de hoje (Timestamp)
        await pool.query(
            'INSERT INTO historico_tarefas (usuario_id, tarefa_id, data) VALUES ($1, $2, NOW())',
            [usuario_id, tarefa_id]
        );

        // 4. Atualiza o saldo
        await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [valor, usuario_id]);

        await pool.query('COMMIT');
        res.json({ success: true, message: "Tarefa concluída!" });

    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        res.status(500).json({ error: "Erro ao processar tarefa." });
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

// --- SISTEMA DE SUPORTE (CHAT) ---

// 1. Enviar Mensagem (Funciona para ambos)
app.post('/api/suporte/enviar', async (req, res) => {
    const { usuario_id, enviado_por, mensagem } = req.body;
    try {
        await pool.query(
            'INSERT INTO suporte_mensagens (usuario_id, enviado_por, mensagem) VALUES ($1, $2, $3)',
            [usuario_id, enviado_por, mensagem]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Erro ao enviar mensagem" });
    }
});

// 2. Admin buscar lista de usuários que mandaram mensagem
app.get('/api/admin/suporte/conversas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (u.id) u.id, u.nome, u.email, m.mensagem, m.data
            FROM usuarios u
            JOIN suporte_mensagens m ON u.id = m.usuario_id
            ORDER BY u.id, m.data DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Erro ao buscar conversas" });
    }
});

// 3. Buscar histórico de uma conversa específica
app.get('/api/suporte/historico/:usuario_id', async (req, res) => {
    const { usuario_id } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM suporte_mensagens WHERE usuario_id = $1 ORDER BY data ASC',
            [usuario_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Erro ao buscar histórico" });
    }
});

// Rota para o Admin salvar/editar VIP completo
app.post('/api/admin/config-vip', async (req, res) => {
    const { nivel, nome, preco, qtd_tarefas, ganho_por_tarefa, ganho_total_mensal } = req.body;
    try {
        await pool.query(
            `INSERT INTO planos_vip (nivel, nome, preco, qtd_tarefas, ganho_por_tarefa, ganho_total_mensal) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             ON CONFLICT (nivel) DO UPDATE SET 
                nome = $2, preco = $3, qtd_tarefas = $4, ganho_por_tarefa = $5, ganho_total_mensal = $6`,
            [nivel, nome, preco, qtd_tarefas, ganho_por_tarefa, ganho_total_mensal]
        );
        res.json({ success: true, message: "Plano VIP atualizado com sucesso!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro ao configurar VIP" });
    }
});

// Rota para listar no Front-end (App)
app.get('/api/vips', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM planos_vip ORDER BY nivel ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Erro ao buscar VIPs" });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Warner Media Server rodando na porta ${PORT}`);
});
