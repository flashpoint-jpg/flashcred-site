const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const app = express();
const PORTA = process.env.PORT || 3000;

// ✅ CONFIGURAÇÕES GERAIS
// Na Vercel os arquivos estáticos (index.html, painel.html, imagens etc.) ficam
// na raiz do projeto e são servidos diretamente pela Vercel — este arquivo cuida
// só das rotas /api/*, por isso não precisamos mais de express.static nem da rota "/".
app.use(express.json());

// ✅ SUPABASE — a URL do projeto não é sensível (já aparece em todo o site),
// mas a chave usada aqui é a chave de SERVIÇO (privilegiada) — só o servidor deve ter acesso a ela.
const SUPABASE_URL = 'https://rgcclordmqjmwuzrrfbd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICO_CHAVE;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// PagBank fica disponível apenas para confirmar cobranças antigas já emitidas.
const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN;
const PAGBANK_API = process.env.PAGBANK_API_URL || 'https://api.pagseguro.com';

// Efí compartilhada pelos apps integrados (Vendai / Entrega Flash / FlashCred).
// As credenciais e o certificado ficam centralizados no backend do Vendai;
// o FlashCred autentica essa chamada com a mesma service role do Supabase.
const EFI_BRIDGE = 'https://vendai-site.vercel.app/api/efi-pix';

async function chamarEfi(acao, corpo = {}) {
    if(!SUPABASE_KEY) throw new Error('SUPABASE_SERVICO_CHAVE não configurada no servidor.');
    const resposta = await fetch(`${EFI_BRIDGE}?action=${encodeURIComponent(acao)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-supabase-service-role': SUPABASE_KEY
        },
        body: JSON.stringify(corpo)
    });
    const texto = await resposta.text();
    let dados = {};
    try { dados = texto ? JSON.parse(texto) : {}; } catch(_) { dados = { raw: texto }; }
    if(!resposta.ok) {
        const detalhe = dados?.provider?.error_description || dados?.provider?.error || dados?.error || `Efí HTTP ${resposta.status}`;
        const erro = new Error(detalhe);
        erro.status = resposta.status;
        erro.dados = dados;
        throw erro;
    }
    return dados;
}

async function chamarPagBank(caminho, opcoes = {}) {
    if(!PAGBANK_TOKEN) throw new Error('PAGBANK_TOKEN não configurado no servidor.');
    const resposta = await fetch(`${PAGBANK_API}${caminho}`, {
        ...opcoes,
        headers: {
            'Authorization': `Bearer ${PAGBANK_TOKEN}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(opcoes.headers || {})
        }
    });
    const texto = await resposta.text();
    let dados = {};
    try { dados = texto ? JSON.parse(texto) : {}; } catch(_) { dados = { raw: texto }; }
    if(!resposta.ok) throw new Error(dados?.error_messages?.[0]?.description || dados?.message || `PagBank HTTP ${resposta.status}`);
    return dados;
}

// ✅ NOTIFICAÇÕES PUSH (funcionam mesmo com o app fechado)
// As chaves VAPID identificam o SEU servidor perante os navegadores/celulares.
// Ficam nas variáveis de ambiente — nunca hardcoded no código.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:flashcred@suporte.com.br',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
} else {
    console.warn('⚠️ VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configuradas — notificações push desativadas.');
}

// Envia uma notificação push para todas as inscrições de um papel/referência.
// Remove automaticamente inscrições que não existem mais (usuário desinstalou o app etc).
async function enviarPushPara(papel, referencia, titulo, corpo, dadosExtras) {
    if(!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
    if(!referencia) {
        console.warn(`⚠️ enviarPushPara('${papel}') chamado sem referência — aviso não enviado.`);
        return;
    }

    const { data: inscricoes, error } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('papel', papel)
        .eq('referencia', String(referencia));

    if(error || !inscricoes || !inscricoes.length) return;

    const payload = JSON.stringify({
        title: titulo,
        body: corpo,
        data: dadosExtras || {}
    });

    for(const inscricao of inscricoes) {
        try {
            await webpush.sendNotification(
                {
                    endpoint: inscricao.endpoint,
                    keys: { p256dh: inscricao.p256dh, auth: inscricao.auth }
                },
                payload
            );
        } catch(erroEnvio) {
            // 404/410 = inscrição expirada/inválida — remove do banco.
            if(erroEnvio.statusCode === 404 || erroEnvio.statusCode === 410) {
                await supabase.from('push_subscriptions').delete().eq('id', inscricao.id);
            } else {
                console.warn('⚠️ Erro ao enviar push:', erroEnvio.message);
            }
        }
    }
}


// Registra toda tentativa de webhook do Mercado Pago — mesmo as que não resultam
// em nada (pagamento ainda pendente, proposta não encontrada, etc). Isso permite
// diagnosticar de verdade se um pagamento "sumiu" por falha do webhook ou se
// simplesmente nunca passou pelo Mercado Pago (ex: Pix pago fora do sistema).
async function registrarLogWebhook({ paymentId, statusMp, referencia, propostaId, tipo, resultado, detalhe }) {
    try {
        await supabase.from('log_webhook_pagamentos').insert({
            payment_id: paymentId ? String(paymentId) : null,
            status_mercadopago: statusMp || null,
            external_reference: referencia || null,
            proposta_id: propostaId ? String(propostaId) : null,
            tipo: tipo || null,
            resultado,
            detalhe: detalhe || null
        });
    } catch(erroLog) {
        console.warn('⚠️ Não foi possível registrar o log do webhook:', erroLog.message);
    }
}

// ✅ REGISTRAR/REMOVER INSCRIÇÃO DE NOTIFICAÇÃO PUSH
app.post('/api/push/registrar', async (req, res) => {
    try {
        const { papel, referencia, subscription } = req.body;

        if(!papel || !referencia || !subscription?.endpoint) {
            return res.json({ sucesso: false, mensagem: 'Dados incompletos.' });
        }

        const { error } = await supabase
            .from('push_subscriptions')
            .upsert({
                papel,
                referencia: String(referencia),
                endpoint: subscription.endpoint,
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth
            }, { onConflict: 'endpoint' });

        if(error) throw error;

        res.json({ sucesso: true });

    } catch(erro) {
        console.error('ERRO AO REGISTRAR PUSH:', erro);
        res.json({ sucesso: false, mensagem: erro.message });
    }
});

app.post('/api/push/remover', async (req, res) => {
    try {
        const { endpoint } = req.body;
        if(endpoint) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
        }
        res.json({ sucesso: true });
    } catch(erro) {
        res.json({ sucesso: false, mensagem: erro.message });
    }
});

// Expõe a chave pública pro front-end (não é segredo, é feita pra ser pública).
app.get('/api/push/chave-publica', (req, res) => {
    res.json({ chave: VAPID_PUBLIC_KEY || null });
});

// ✅ PIX FLASHCRED — Efí compartilhada
app.post('/api/gerar-pix', async (req, res) => {
    try {
        const valorLimpo = Number(String(req.body.valor).replace(/[^0-9,.]/g, '').replace(',', '.'));
        const propostaId = Number(req.body.proposta_id);
        const tipo = String(req.body.tipo || 'entrada');
        const numeroParcela = req.body.numero_parcela != null ? Number(req.body.numero_parcela) : null;

        if(!Number.isFinite(valorLimpo) || valorLimpo <= 0) {
            return res.status(400).json({ sucesso: false, mensagem: 'Valor inválido' });
        }
        if(!Number.isInteger(propostaId) || propostaId <= 0 || !['entrada','parcela'].includes(tipo)) {
            return res.status(400).json({ sucesso: false, mensagem: 'Cobrança inválida' });
        }

        const { data: proposta, error: erroProposta } = await supabase
            .from('propostas')
            .select('id,nome,cpf,funcionario_id,valor_desejado,valor_entrada,parcelas_pagas,entrada_paga,qtd_parcelas_escolhida,quantidade_parcelas,juros_mensal')
            .eq('id', propostaId)
            .maybeSingle();

        if(erroProposta || !proposta) {
            return res.status(404).json({ sucesso: false, mensagem: 'Proposta não encontrada' });
        }

        if(tipo === 'entrada') {
            if(proposta.entrada_paga) {
                return res.status(409).json({ sucesso: false, mensagem: 'A entrada desta proposta já está paga.' });
            }
            const entradaEsperada = Number(proposta.valor_entrada || 0);
            if(entradaEsperada > 0 && Math.abs(valorLimpo - entradaEsperada) > 0.05) {
                return res.status(409).json({ sucesso: false, mensagem: 'O valor da entrada mudou. Atualize a página e tente novamente.' });
            }
        } else {
            const pagas = Number(proposta.parcelas_pagas || 0);
            if(!Number.isInteger(numeroParcela) || numeroParcela !== pagas + 1) {
                return res.status(409).json({ sucesso: false, mensagem: 'Esta não é a próxima parcela em aberto.' });
            }

            const qtd = Number(proposta.qtd_parcelas_escolhida || proposta.quantidade_parcelas || 0);
            const principal = Math.max(0, Number(proposta.valor_desejado || 0) - Number(proposta.valor_entrada || 0));
            const juros = Number(proposta.juros_mensal || 0) / 100;
            let base = 0;
            if(qtd > 0 && principal > 0) {
                base = juros > 0
                    ? principal * (juros * Math.pow(1 + juros, qtd)) / (Math.pow(1 + juros, qtd) - 1)
                    : principal / qtd;
            }
            if(base > 0 && valorLimpo + 0.05 < base) {
                return res.status(409).json({ sucesso: false, mensagem: 'O valor da parcela está abaixo do valor oficial. Atualize a página.' });
            }
        }

        const { data: existente } = await supabase
            .from('flashcred_pix_pagamentos')
            .select('txid,copia_cola,valor,status,criado_em')
            .eq('proposta_id', propostaId)
            .eq('tipo', tipo)
            .eq('numero_parcela', numeroParcela)
            .eq('status', 'pendente')
            .gte('criado_em', new Date(Date.now() - 24*60*60*1000).toISOString())
            .order('criado_em', { ascending: false })
            .limit(1)
            .maybeSingle();

        if(existente && Math.abs(Number(existente.valor) - valorLimpo) <= 0.01 && existente.copia_cola) {
            return res.json({
                sucesso: true,
                qr_code: existente.copia_cola,
                payment_id: existente.txid,
                txid: existente.txid,
                provider: 'efi',
                reutilizado: true
            });
        }

        const descricao = req.body.descricao || (tipo === 'parcela'
            ? `Parcela ${numeroParcela} - Proposta ${propostaId}`
            : `Entrada - Proposta ${propostaId}`);

        const cobranca = await chamarEfi('create', {
            valor: Math.round(valorLimpo * 100) / 100,
            descricao,
            expiracao_seconds: 86400
        });

        const txid = String(cobranca?.txid || cobranca?.cobranca_id || '');
        const copiaCola = String(cobranca?.copia_cola || '');
        if(!txid || !copiaCola) throw new Error('A Efí não retornou o código PIX.');

        const { error: erroSalvar } = await supabase
            .from('flashcred_pix_pagamentos')
            .insert({
                txid,
                proposta_id: propostaId,
                tipo,
                numero_parcela: numeroParcela,
                valor: Math.round(valorLimpo * 100) / 100,
                status: 'pendente',
                copia_cola: copiaCola,
                provider: 'efi'
            });

        if(erroSalvar) {
            console.error('PIX Efí criado, mas não foi possível registrar:', erroSalvar);
            throw new Error('PIX criado, mas não foi possível registrar a cobrança.');
        }

        res.json({
            sucesso: true,
            qr_code: copiaCola,
            payment_id: txid,
            txid,
            provider: 'efi'
        });
    } catch (erro) {
        console.error('ERRO EFI PIX:', erro);
        res.status(502).json({ sucesso: false, mensagem: erro.message || 'Não foi possível gerar o PIX agora.' });
    }
});

// Gera (se ainda não existir) a comissão do funcionário responsável pela proposta.
// Reaproveitado tanto no fluxo de entrada quanto — se um dia precisar — em outro gatilho.
async function gerarComissaoSeNecessario(propostaId, proposta) {
    if(!proposta?.funcionario_id) return null;

    const { data: existente } = await supabase
        .from('comissoes')
        .select('id')
        .eq('proposta_id', propostaId)
        .maybeSingle();

    if(existente) return null;

    const { data: func } = await supabase
        .from('funcionarios')
        .select('percentual_comissao')
        .eq('id', proposta.funcionario_id)
        .maybeSingle();

    const percentual = Number(func?.percentual_comissao) || 0;
    if(percentual <= 0) return null;

    const valorComissao = (Number(proposta.valor_desejado) || 0) * percentual / 100;

    await supabase.from('comissoes').insert([{
        proposta_id: propostaId,
        funcionario_id: proposta.funcionario_id,
        porcentagem: percentual,
        valor_comissao: valorComissao,
        status: 'disponivel'
    }]);

    console.log(`✅ Comissão gerada para o funcionário da proposta ${propostaId}.`);
    return valorComissao;
}

// ✅ WEBHOOK PAGBANK LEGADO — mantém baixa de cobranças antigas já emitidas
app.post('/api/webhook-pagbank', async (req, res) => {
    try {
        const orderId = req.body?.id || req.body?.order?.id;
        if(!orderId || !String(orderId).startsWith('ORDE_')) return res.sendStatus(200);
        const pedido = await chamarPagBank(`/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
        const referencia = pedido?.reference_id || '';
        const cobranca = (pedido?.charges || [])[0];
        const status = cobranca?.status || (pedido?.qr_codes?.[0]?.status);
        if(status !== 'PAID') return res.sendStatus(200);

        const partes = referencia.split(':');
        const tipo = partes[0];
        const propostaId = partes[1];
        const numeroParcela = partes[2] ? Number(partes[2]) : null;
        if(!propostaId) return res.sendStatus(200);

        const { data: proposta } = await supabase.from('propostas')
            .select('nome, cpf, funcionario_id, valor_desejado, parcelas_pagas, entrada_paga')
            .eq('id', propostaId).maybeSingle();
        if(!proposta) return res.sendStatus(200);

        if(tipo === 'entrada' && !proposta.entrada_paga) {
            const { error } = await supabase.from('propostas').update({ entrada_paga: true, data_pagamento_entrada: new Date().toISOString() }).eq('id', propostaId);
            if(!error) {
                enviarPushPara('cliente', proposta.cpf, '✅ Entrada confirmada!', 'Seu pagamento foi recebido. Acompanhe o andamento pelo app.', { url: '/consultar.html' });
                enviarPushPara('admin', 'admin', '💰 Entrada Pix confirmada', `${proposta.nome || 'Cliente'} — entrada da proposta #${propostaId} recebida via PagBank (legado).`, { url: '/painel.html' });
                try { await gerarComissaoSeNecessario(propostaId, proposta); } catch(_) {}
            }
        } else if(tipo === 'parcela' && numeroParcela) {
            const pagas = Number(proposta.parcelas_pagas || 0);
            if(numeroParcela === pagas + 1) {
                const { error } = await supabase.from('propostas').update({ parcelas_pagas: numeroParcela }).eq('id', propostaId).eq('parcelas_pagas', pagas);
                if(!error) {
                    enviarPushPara('cliente', proposta.cpf, '✅ Parcela paga!', `Sua ${numeroParcela}ª parcela foi confirmada.`, { url: '/consultar.html' });
                    enviarPushPara('admin', 'admin', '💵 Parcela Pix confirmada', `${proposta.nome || 'Cliente'} — ${numeroParcela}ª parcela via PagBank (legado).`, { url: '/painel.html' });
                }
            }
        }
        res.sendStatus(200);
    } catch(erro) {
        console.error('ERRO WEBHOOK PAGBANK:', erro);
        res.sendStatus(200);
    }
});

// ✅ AVISO DE PROPOSTA NOVA — chamado automaticamente pelo banco (Supabase)
// toda vez que uma linha nova entra na tabela "propostas", seja pelo site,
// seja pelo funcionário. Dispara push pro admin mesmo com o painel fechado.
app.post('/api/webhook-nova-proposta', async (req, res) => {
    try {
        const { nome, valor_desejado, forma_pagamento_entrada } = req.body || {};

        const avisoPagamento = forma_pagamento_entrada === 'na_entrega'
            ? ' 📦 Entrada na entrega'
            : '';

        await enviarPushPara(
            'admin',
            'admin',
            '🆕 Nova proposta recebida',
            `${nome || 'Cliente'} — R$ ${Number(valor_desejado || 0).toFixed(2)}${avisoPagamento}`,
            { url: '/painel.html' }
        );

        res.sendStatus(200);

    } catch(erro) {
        console.error('❌ Erro no webhook de proposta nova:', erro);
        res.sendStatus(200); // sempre 200 pra não travar o banco tentando de novo
    }
});

// ✅ RECONCILIAÇÃO EFÍ — baixa automática, parcelas e push
app.all('/api/reconciliar-pagamentos', async (req, res) => {
    try {
        const { data: pendentes, error } = await supabase
            .from('flashcred_pix_pagamentos')
            .select('*')
            .eq('provider', 'efi')
            .eq('status', 'pendente')
            .order('criado_em', { ascending: true })
            .limit(100);

        if(error) throw error;

        let pagos = 0, expirados = 0, erros = 0;

        for(const pagamento of (pendentes || [])) {
            try {
                const consulta = await chamarEfi('status', { txid: pagamento.txid });
                const status = String(consulta?.status || '').toUpperCase();
                const valorEfi = Number(consulta?.valor || 0);
                const valorEsperado = Number(pagamento.valor || 0);

                if(consulta?.pago === true || status === 'CONCLUIDA') {
                    if(Math.abs(valorEfi - valorEsperado) > 0.01) {
                        await supabase.from('flashcred_pix_pagamentos')
                            .update({ status: 'erro', atualizado_em: new Date().toISOString() })
                            .eq('id', pagamento.id);
                        erros++;
                        continue;
                    }

                    const { data: proposta } = await supabase.from('propostas')
                        .select('nome,cpf,funcionario_id,valor_desejado,parcelas_pagas,entrada_paga')
                        .eq('id', pagamento.proposta_id)
                        .maybeSingle();

                    if(!proposta) {
                        await supabase.from('flashcred_pix_pagamentos')
                            .update({ status: 'erro', atualizado_em: new Date().toISOString() })
                            .eq('id', pagamento.id);
                        erros++;
                        continue;
                    }

                    if(pagamento.tipo === 'entrada') {
                        if(!proposta.entrada_paga) {
                            const { error: erroBaixa } = await supabase.from('propostas')
                                .update({ entrada_paga: true, data_pagamento_entrada: new Date().toISOString() })
                                .eq('id', pagamento.proposta_id)
                                .eq('entrada_paga', false);

                            if(erroBaixa) throw erroBaixa;

                            await enviarPushPara('cliente', proposta.cpf, '✅ Entrada confirmada!', 'Seu pagamento foi recebido. Acompanhe o andamento pelo app.', { url: '/consultar.html' });
                            await enviarPushPara('admin', 'admin', '💰 Entrada Pix confirmada', `${proposta.nome || 'Cliente'} — entrada da proposta #${pagamento.proposta_id} recebida via Efí.`, { url: '/painel.html' });
                            try { await gerarComissaoSeNecessario(pagamento.proposta_id, proposta); } catch(_) {}
                        }
                    } else if(pagamento.tipo === 'parcela' && pagamento.numero_parcela) {
                        const pagas = Number(proposta.parcelas_pagas || 0);
                        const numero = Number(pagamento.numero_parcela);

                        if(numero === pagas + 1) {
                            const { error: erroBaixa } = await supabase.from('propostas')
                                .update({ parcelas_pagas: numero })
                                .eq('id', pagamento.proposta_id)
                                .eq('parcelas_pagas', pagas);
                            if(erroBaixa) throw erroBaixa;

                            await enviarPushPara('cliente', proposta.cpf, '✅ Parcela paga!', `Sua ${numero}ª parcela foi confirmada.`, { url: '/consultar.html' });
                            await enviarPushPara('admin', 'admin', '💵 Parcela Pix confirmada', `${proposta.nome || 'Cliente'} — ${numero}ª parcela recebida via Efí.`, { url: '/painel.html' });
                        } else if(numero > pagas + 1) {
                            continue;
                        }
                    }

                    await supabase.from('flashcred_pix_pagamentos')
                        .update({
                            status: 'pago',
                            pago_em: new Date().toISOString(),
                            atualizado_em: new Date().toISOString()
                        })
                        .eq('id', pagamento.id)
                        .eq('status', 'pendente');
                    pagos++;
                    continue;
                }

                const criado = new Date(pagamento.criado_em).getTime();
                if(status.includes('REMOVIDA') || Date.now() - criado > 24*60*60*1000) {
                    await supabase.from('flashcred_pix_pagamentos')
                        .update({ status: 'expirado', atualizado_em: new Date().toISOString() })
                        .eq('id', pagamento.id)
                        .eq('status', 'pendente');
                    expirados++;
                }
            } catch(erroItem) {
                erros++;
                console.error('Erro conciliando PIX Efí', pagamento.txid, erroItem);
            }
        }

        res.json({ sucesso: true, provider: 'efi', pagos, expirados, erros });
    } catch (erro) {
        console.error('ERRO RECONCILIACAO EFI:', erro);
        res.status(500).json({ sucesso: false, provider: 'efi', mensagem: erro.message });
    }
});

// ✅ VERIFICAÇÃO DE SENHA DO PAINEL ADMIN
// A senha fica só aqui no servidor (variável de ambiente), nunca no código do navegador.
app.post('/api/verificar-senha-admin', (req, res) => {
    const senhaEnviada = String(req.body.senha || '');
    const senhaCorreta = process.env.ADMIN_PASSWORD || '';

    if(!senhaCorreta) {
        console.error('⚠️ ADMIN_PASSWORD não está configurada no servidor.');
        return res.json({ ok: false, mensagem: 'Senha de admin não configurada no servidor.' });
    }

    res.json({ ok: senhaEnviada === senhaCorreta });
});

// ✅ CHECAGEM DIÁRIA DE VENCIMENTO DE PARCELAS
// Avisa por push (mesmo com o app fechado) quem tem parcela vencendo em até
// 3 dias ou já vencida. Roda de duas formas:
//   1) Sozinha, a cada 6h, enquanto o servidor estiver de pé.
//   2) Sob demanda, chamando esta rota via um cron externo (recomendado —
//      veja a explicação depois do código). Isso garante que rode mesmo se
//      o servidor "dormir" no plano gratuito do Render.
async function checarVencimentosEAvisar() {
    try {
        const { data: propostas, error } = await supabase
            .from('propostas')
            .select('id, cpf, entrada_paga, parcelas_pagas, quantidade_parcelas, qtd_parcelas_escolhida, datas_parcelas')
            .eq('entrada_paga', true);

        if(error) {
            console.error('❌ Erro ao buscar propostas para checagem de vencimento:', error);
            return;
        }

        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        for(const proposta of (propostas || [])) {

            const quantidade = Number(proposta.qtd_parcelas_escolhida || proposta.quantidade_parcelas) || 0;
            const pagas = Number(proposta.parcelas_pagas) || 0;
            const datas = Array.isArray(proposta.datas_parcelas) ? proposta.datas_parcelas : [];

            if(pagas >= quantidade || !datas[pagas]) continue;

            const vencimento = new Date(datas[pagas] + 'T00:00:00');
            const diasRestantes = Math.round((vencimento - hoje) / 86400000);

            if(diasRestantes > 3) continue;

            const numeroParcela = pagas + 1;

            // Evita avisar duas vezes no mesmo dia pela mesma parcela.
            const { error: erroLog } = await supabase
                .from('push_avisos_vencimento')
                .insert({ proposta_id: proposta.id, numero_parcela: numeroParcela });

            if(erroLog) continue; // já foi avisado hoje (violação da constraint única) — pula

            let titulo, corpo;
            if(diasRestantes < 0) {
                titulo = '⚠️ Parcela em atraso';
                corpo = `Sua ${numeroParcela}ª parcela venceu — regularize para manter seu limite liberado.`;
            } else if(diasRestantes === 0) {
                titulo = '📅 Parcela vence hoje!';
                corpo = `Sua ${numeroParcela}ª parcela vence hoje. Não esqueça de pagar.`;
            } else {
                titulo = '📅 Parcela vencendo em breve';
                corpo = `Sua ${numeroParcela}ª parcela vence em ${diasRestantes} dia(s).`;
            }

            await enviarPushPara('cliente', proposta.cpf, titulo, corpo, { url: '/consultar.html' });
        }

    } catch(erro) {
        console.error('❌ Erro na checagem de vencimentos:', erro);
    }
}

// ✅ CHECAGEM DE ENTREGAS PRÓXIMAS (aviso pro admin quando faltam 2 dias)
// Roda junto da checagem de vencimento de parcelas, mesma lógica de dedupe
// (não avisa duas vezes no mesmo dia sobre a mesma entrega).
async function checarEntregasProximasEAvisar() {
    try {
        const { data: propostas, error } = await supabase
            .from('propostas')
            .select('id, nome, data_preferida_entrega, contrato_assinado, entrada_paga, entrega_concluida')
            .eq('contrato_assinado', true)
            .eq('entrada_paga', true)
            .eq('entrega_concluida', false)
            .not('data_preferida_entrega', 'is', null);

        if(error) {
            console.error('❌ Erro ao buscar propostas para checagem de entregas próximas:', error);
            return;
        }

        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        for(const proposta of (propostas || [])) {
            const dataEntrega = new Date(proposta.data_preferida_entrega + 'T00:00:00');
            const diasRestantes = Math.round((dataEntrega - hoje) / 86400000);

            // Avisa quando faltam exatamente 2 dias ou menos (inclui hoje/atrasada),
            // mas não spamma pra entregas muito distantes no futuro.
            if(diasRestantes > 2) continue;

            const { error: erroLog } = await supabase
                .from('push_avisos_entrega')
                .insert({ proposta_id: String(proposta.id) });

            if(erroLog) continue; // já avisado hoje sobre essa entrega — pula

            let titulo, corpo;
            if(diasRestantes < 0) {
                titulo = '⚠️ Entrega atrasada';
                corpo = `${proposta.nome || 'Cliente'} — a data agendada já passou.`;
            } else if(diasRestantes === 0) {
                titulo = '🔴 Entrega é hoje!';
                corpo = `${proposta.nome || 'Cliente'} — entrega agendada para hoje.`;
            } else {
                titulo = '⏰ Entrega em breve';
                corpo = `${proposta.nome || 'Cliente'} — faltam ${diasRestantes} dia(s) para a entrega agendada.`;
            }

            await enviarPushPara('admin', 'admin', titulo, corpo, { url: '/painel.html' });
        }

    } catch(erro) {
        console.error('❌ Erro na checagem de entregas próximas:', erro);
    }
}

// Rota que um cron externo pode chamar (ex: cron-job.org, grátis) uma vez por dia.
// Aceita GET e POST — assim não importa como o serviço de cron está configurado.
app.all('/api/push/checar-vencimentos', async (req, res) => {
    await checarVencimentosEAvisar();
    await checarEntregasProximasEAvisar();
    res.json({ sucesso: true });
});

// ⚠️ Na Vercel (serverless) não existe processo rodando o tempo todo, então os
// antigos setInterval() daqui não funcionam mais — cada função só liga quando é
// chamada e desliga em seguida. As rotas /api/push/checar-vencimentos e
// /api/reconciliar-pagamentos continuam existindo normalmente; agora que disparem
// no horário certo é responsabilidade de um cron EXTERNO (ex: cron-job.org) batendo
// nessas URLs a cada 1h/6h. Configure isso no cron-job.org apontando para:
//   https://SEU-DOMINIO/api/push/checar-vencimentos   (a cada 6h)
//   https://SEU-DOMINIO/api/reconciliar-pagamentos    (a cada 1h)

// Local (fora da Vercel) ainda dá pra rodar `node api/index.js` normalmente para testar:
if (require.main === module) {
    app.listen(PORTA, () => {
        console.log(`✅ FlashCred rodando localmente em http://localhost:${PORTA}`);
    });
}

// ✅ Exporta o app Express — é isso que a Vercel usa como função serverless.
module.exports = app;
