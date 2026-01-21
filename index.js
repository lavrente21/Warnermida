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
// --- ROTA PARA BUSCAR TAREFAS DISPONÍVEIS (PRONTA) ---
app.get('/api/tarefas-disponiveis/:usuario_id', async (req, res) => {
    const { usuario_id } = req.params;

    // 1. Validação de segurança para evitar o erro "invalid input syntax for type integer"
    if (!usuario_id || usuario_id === "undefined" || isNaN(parseInt(usuario_id))) {
        return res.status(400).json({ error: "ID de utilizador inválido ou não fornecido." });
    }

    try {
        // 2. Busca o nível VIP do usuário e o limite de tarefas configurado para esse nível
        const userRes = await pool.query(`
            SELECT u.nivel_vip, p.qtd_tarefas 
            FROM usuarios u 
            LEFT JOIN planos_vip p ON u.nivel_vip = p.nivel 
            WHERE u.id = $1`, 
            [parseInt(usuario_id)]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }
        
        const user = userRes.rows[0];
        const nivelVip = user.nivel_vip || 0;
        const limiteTarefas = user.qtd_tarefas || 0; 

        // 3. Conta quantas tarefas o usuário já realizou HOJE
        // (Considerando a data atual do servidor)
        const hoje = new Date().toISOString().split('T')[0];
        const historicoRes = await pool.query(
            'SELECT COUNT(*) FROM historico_tarefas WHERE usuario_id = $1 AND data::date = $2',
            [parseInt(usuario_id), hoje]
        );
        const totalFeitosHoje = parseInt(historicoRes.rows[0].count);

        // 4. Lógica de Bloqueio: Se já atingiu o limite do plano VIP
        if (totalFeitosHoje >= limiteTarefas) {
            return res.json({ 
                concluido: true, 
                mensagem: "Você concluiu todas as tarefas do seu nível hoje! Volte amanhã ou suba de VIP." 
            });
        }

        // 5. Busca as tarefas que o usuário pode fazer (nível dele ou inferior)
        // Se o usuário for VIP 1, ele vê tarefas de nível 0 e 1.
        const tarefasRes = await pool.query(
            'SELECT * FROM tarefas WHERE nivel_minimo <= $1 ORDER BY id DESC',
            [nivelVip]
        );

        // Retorna a lista de tarefas para o App
        res.json(tarefasRes.rows);

    } catch (err) {
        console.error("❌ Erro ao buscar tarefas:", err);
        res.status(500).json({ error: "Erro interno no servidor ao carregar tarefas." });
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
    const { usuario_id, nivel_vip, valor_pago } = req.body;

    try {
        await pool.query('BEGIN');

        // 1. Busca o saldo atual do usuário
        const userRes = await pool.query('SELECT saldo FROM usuarios WHERE id = $1', [usuario_id]);
        const user = userRes.rows[0];

        if (!user) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: "Usuário não encontrado" });
        }

        // 2. Verifica se tem saldo suficiente
        if (parseFloat(user.saldo) < parseFloat(valor_pago)) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: "Saldo insuficiente" });
        }

        // 3. Deduz o saldo e atualiza o nível VIP
        await pool.query(
            'UPDATE usuarios SET saldo = saldo - $1, nivel_vip = $2 WHERE id = $3',
            [valor_pago, nivel_vip, usuario_id]
        );

        await pool.query('COMMIT');
        res.json({ success: true, message: `VIP ${nivel_vip} ativado!` });

    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error("Erro ao comprar VIP:", err);
        res.status(500).json({ error: "Erro interno ao processar compra" });
    }
});

// --- ROTA DE POSTBACK CPAGRIP (FORA DE OUTRAS FUNÇÕES) ---
app.get('/api/postback-cpagrip', async (req, res) => {
    try {
        const userId = req.query.user_id;
        
        if (!userId || userId === "{tracking_id}") {
            return res.status(400).send("ID inválido ou teste do painel CPAGrip.");
        }

        const valorRecompensa = 250; 

        const result = await pool.query(
            'UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2 RETURNING nome, saldo',
            [valorRecompensa, userId]
        );

        if (result.rows.length > 0) {
            console.log(`✅ Sucesso CPAGrip: ${valorRecompensa} Kz para ID ${userId}`);
            return res.status(200).send("OK");
        } else {
            return res.status(404).send("Usuário não encontrado.");
        }
    } catch (error) {
        console.error("Erro no Postback:", error);
        res.status(500).send("Erro interno.");
    }
});

// 3. ROTA PARA PROCESSAR SAQUE (Pagar ou Recusar)
app.post('/api/admin/processar-saque', async (req, res) => {
    const { saque_id, status } = req.body;
    try {
        if (status === 'rejeitado') {
            // Se rejeitar, devolve o dinheiro ao saldo do usuário
            const saqueRes = await pool.query('SELECT usuario_id, valor FROM saques WHERE id = $1', [saque_id]);
            const saque = saqueRes.rows[0];
            await pool.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [saque.valor, saque.usuario_id]);
        }
        await pool.query('UPDATE saques SET status = $1 WHERE id = $2', [status, saque_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Erro ao atualizar saque" });
    }
});

// --- ATUALIZAÇÃO DO SUPORTE (Para ler imagens corretamente) ---

// No seu app.get('/api/suporte/historico/:usuario_id'), o código já está bom. 
// O segredo está no FRONT-END (HTML) que enviará a tag <img> dentro do texto.

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
