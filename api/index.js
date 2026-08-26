const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');
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

// ✅ MERCADO PAGO — VERSÃO NOVA CORRIGIDA
const mpConfig = new MercadoPagoConfig({
    accessToken: process.env.MERCADO_PAGO_TOKEN
});
const pagamentoServico = new Payment(mpConfig);

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

// ✅ ROTA DE GERA PIX — LIMPEZA DE VALOR E TUDO
app.post('/api/gerar-pix', async (req, res) => {
    try {
        const valorLimpo = Number(
            String(req.body.valor)
            .replace(/[^0-9,.]/g, '')
            .replace(',', '.')
        );

        if(isNaN(valorLimpo) || valorLimpo <= 0) {
            return res.json({sucesso: false, mensagem: 'Valor inválido'});
        }

        // ✅ Identifica a que proposta/parcela esse Pix pertence.
        // Isso é o que o webhook vai usar depois para saber o que atualizar no Supabase.
        const propostaId = req.body.proposta_id || null;
        const tipo = req.body.tipo || 'entrada'; // 'entrada' ou 'parcela'
        const numeroParcela = req.body.numero_parcela || null;

        let externalReference = null;
        if(propostaId) {
            externalReference = tipo === 'parcela'
                ? `parcela:${propostaId}:${numeroParcela || ''}`
                : `entrada:${propostaId}`;
        }

        // ✅ URL pública deste servidor, montada a partir da própria requisição.
        // Assim funciona em qualquer domínio/deploy sem precisar hardcodar nada.
        const notificationUrl = `${req.protocol}://${req.get('host')}/api/webhook-mercadopago`;

        const pagamento = await pagamentoServico.create({
            body: {
                transaction_amount: valorLimpo,
                description: req.body.descricao || 'Pagamento FlashCred',
                payment_method_id: 'pix',
                payer: { email: 'flashcred@suporte.com.br' },
                notification_url: notificationUrl,
                ...(externalReference ? { external_reference: externalReference } : {})
            }
        });

        res.json({
            sucesso: true,
            qr_code: pagamento.point_of_interaction.transaction_data.qr_code
        });

    } catch (erro) {
        console.error('ERRO:', erro);
        res.json({sucesso: false, mensagem: erro.message});
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

// ✅ WEBHOOK DO MERCADO PAGO — recebe a notificação de pagamento e dá baixa na proposta
// Aceita GET e POST porque o Mercado Pago pode chamar de formas diferentes dependendo da config.
app.all('/api/webhook-mercadopago', async (req, res) => {
    try {
        // O ID do pagamento pode vir no corpo (notificação nova) ou na query (formato antigo/IPN)
        const paymentId =
            req.body?.data?.id ||
            req.body?.id ||
            req.query['data.id'] ||
            req.query.id;

        const tipoNotificacao = req.body?.type || req.body?.topic || req.query.type || req.query.topic;

        // Só nos interessa notificação de pagamento
        if(!paymentId || (tipoNotificacao && tipoNotificacao !== 'payment')) {
            await registrarLogWebhook({
                paymentId, tipo: tipoNotificacao,
                resultado: 'ignorado',
                detalhe: !paymentId ? 'Chamada sem payment id' : `Tipo de notificação irrelevante: ${tipoNotificacao}`
            });
            return res.sendStatus(200);
        }

        // ✅ Busca o pagamento completo direto na API do Mercado Pago (nunca confiar só no payload recebido)
        const pagamento = await pagamentoServico.get({ id: paymentId });

        if(pagamento.status !== 'approved') {
            // Pix pendente, rejeitado, cancelado etc — não faz nada ainda
            await registrarLogWebhook({
                paymentId, statusMp: pagamento.status, referencia: pagamento.external_reference,
                resultado: 'nao_aprovado',
                detalhe: `Status do pagamento: ${pagamento.status}`
            });
            return res.sendStatus(200);
        }

        const referencia = pagamento.external_reference || '';
        const partes = referencia.split(':');
        const tipo = partes[0];
        const propostaId = partes[1];
        const numeroParcela = partes[2] ? Number(partes[2]) : null;

        if(!propostaId) {
            console.warn('⚠️ Pagamento aprovado sem external_reference reconhecível:', paymentId);
            await registrarLogWebhook({
                paymentId, statusMp: pagamento.status, referencia,
                resultado: 'sem_referencia',
                detalhe: 'Pagamento aprovado mas sem external_reference reconhecível — não veio do QR gerado pelo sistema.'
            });
            return res.sendStatus(200);
        }

        // Busca a proposta uma única vez — precisamos do CPF (pra avisar o cliente, que se
        // inscreve na notificação pelo CPF, não pelo ID da proposta) e do funcionario_id
        // (pra avisar o funcionário responsável, se houver).
        const { data: proposta, error: erroProposta } = await supabase
            .from('propostas')
            .select('nome, cpf, funcionario_id, valor_desejado, parcelas_pagas')
            .eq('id', propostaId)
            .maybeSingle();

        if(erroProposta || !proposta) {
            console.error('❌ Não foi possível carregar a proposta', propostaId, erroProposta);
            await registrarLogWebhook({
                paymentId, statusMp: pagamento.status, referencia, propostaId, tipo,
                resultado: 'proposta_nao_encontrada',
                detalhe: erroProposta?.message || 'Proposta não encontrada no banco.'
            });
            return res.sendStatus(200);
        }

        if(tipo === 'entrada') {

            const { error } = await supabase
                .from('propostas')
                .update({
                    entrada_paga: true,
                    data_pagamento_entrada: new Date().toISOString()
                })
                .eq('id', propostaId);

            if(error) {
                console.error('❌ Erro ao atualizar entrada da proposta', propostaId, error);
                await registrarLogWebhook({
                    paymentId, statusMp: pagamento.status, referencia, propostaId, tipo,
                    resultado: 'erro_ao_atualizar',
                    detalhe: error.message
                });
            } else {
                console.log(`✅ Entrada da proposta ${propostaId} confirmada via Pix.`);

                await registrarLogWebhook({
                    paymentId, statusMp: pagamento.status, referencia, propostaId, tipo,
                    resultado: 'sucesso',
                    detalhe: `Entrada confirmada para ${proposta.nome || 'cliente'}.`
                });

                // Cliente se inscreve pelo CPF — é isso que tem que ser usado aqui, não o ID da proposta.
                enviarPushPara('cliente', proposta.cpf, '✅ Entrada confirmada!', 'Seu pagamento foi recebido. Acompanhe o andamento pelo app.', { url: '/consultar.html' });
                enviarPushPara('admin', 'admin', '💰 Entrada Pix confirmada', `${proposta.nome || 'Cliente'} — entrada da proposta #${propostaId} recebida.`, { url: '/painel.html' });

                // Gera a comissão do funcionário (se ainda não existir) agora que a entrada foi confirmada.
                try {
                    const valorComissao = await gerarComissaoSeNecessario(propostaId, proposta);

                    if(valorComissao !== null && proposta.funcionario_id) {
                        enviarPushPara(
                            'funcionario',
                            proposta.funcionario_id,
                            '💰 Comissão liberada!',
                            `A entrada de ${proposta.nome || 'seu cliente'} foi confirmada — sua comissão de R$ ${valorComissao.toFixed(2)} já está disponível.`,
                            { url: '/funcionario.html' }
                        );
                    }
                } catch(erroComissao) {
                    console.warn('⚠️ Não foi possível gerar a comissão do funcionário:', erroComissao);
                }
            }

        } else if(tipo === 'parcela' && numeroParcela) {

            const parcelasPagasAtual = Number(proposta.parcelas_pagas || 0);
            const novoValor = Math.max(parcelasPagasAtual, numeroParcela);

            const { error: erroUpdate } = await supabase
                .from('propostas')
                .update({ parcelas_pagas: novoValor })
                .eq('id', propostaId);

            if(erroUpdate) {
                console.error('❌ Erro ao atualizar parcela da proposta', propostaId, erroUpdate);
                await registrarLogWebhook({
                    paymentId, statusMp: pagamento.status, referencia, propostaId, tipo,
                    resultado: 'erro_ao_atualizar',
                    detalhe: erroUpdate.message
                });
            } else {
                console.log(`✅ Parcela ${numeroParcela} da proposta ${propostaId} confirmada via Pix.`);

                await registrarLogWebhook({
                    paymentId, statusMp: pagamento.status, referencia, propostaId, tipo,
                    resultado: 'sucesso',
                    detalhe: `Parcela ${numeroParcela} confirmada para ${proposta.nome || 'cliente'}.`
                });

                enviarPushPara('cliente', proposta.cpf, '✅ Parcela paga!', `Sua ${numeroParcela}ª parcela foi confirmada. Seu limite já foi atualizado.`, { url: '/consultar.html' });
                enviarPushPara('admin', 'admin', '💵 Parcela Pix confirmada', `${proposta.nome || 'Cliente'} — pagou a ${numeroParcela}ª parcela da proposta #${propostaId}.`, { url: '/painel.html' });

                if(proposta.funcionario_id) {
                    enviarPushPara(
                        'funcionario',
                        proposta.funcionario_id,
                        '📦 Parcela do seu cliente foi paga',
                        `${proposta.nome || 'Seu cliente'} pagou a ${numeroParcela}ª parcela.`,
                        { url: '/funcionario.html' }
                    );
                }
            }
        } else {
            // tipo diferente de 'entrada'/'parcela', ou 'parcela' sem número — não bate com nada tratado.
            await registrarLogWebhook({
                paymentId, statusMp: pagamento.status, referencia, propostaId, tipo,
                resultado: 'tipo_nao_tratado',
                detalhe: `external_reference não reconhecido pelo webhook: "${referencia}"`
            });
        }

        res.sendStatus(200);

    } catch (erro) {
        // Sempre responde 200 para o Mercado Pago não ficar reenviando em loop —
        // o erro real fica registrado no log do servidor para investigação.
        console.error('ERRO NO WEBHOOK:', erro);
        try {
            await supabase.from('log_webhook_pagamentos').insert({
                resultado: 'erro_inesperado',
                detalhe: erro.message
            });
        } catch(_) {}
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

// ✅ RECONCILIAÇÃO — rede de segurança pra pagamentos que o webhook perdeu
// (ex: Mercado Pago não conseguiu entregar a notificação, servidor estava
// dormindo no plano grátis do Render, etc). Varre os pagamentos Pix recentes
// direto na API do Mercado Pago e confere um por um contra o banco — se achar
// algum aprovado que não bateu no webhook, corrige e avisa na hora.
app.all('/api/reconciliar-pagamentos', async (req, res) => {
    try {
        const desde = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // últimos 3 dias

        const busca = await pagamentoServico.search({
            options: {
                sort: 'date_created',
                criteria: 'desc',
                range: 'date_created',
                begin_date: desde,
                end_date: new Date().toISOString()
            }
        });

        const pagamentosAprovados = (busca?.results || []).filter(p => p.status === 'approved' && p.external_reference);

        let corrigidos = 0;

        for(const pagamento of pagamentosAprovados) {
            const partes = String(pagamento.external_reference).split(':');
            const tipo = partes[0];
            const propostaId = partes[1];
            const numeroParcela = partes[2] ? Number(partes[2]) : null;

            if(!propostaId) continue;

            const { data: proposta } = await supabase
                .from('propostas')
                .select('nome, cpf, funcionario_id, valor_desejado, entrada_paga, parcelas_pagas')
                .eq('id', propostaId)
                .maybeSingle();

            if(!proposta) continue;

            if(tipo === 'entrada' && !proposta.entrada_paga) {
                await supabase.from('propostas').update({
                    entrada_paga: true,
                    data_pagamento_entrada: new Date().toISOString()
                }).eq('id', propostaId);

                enviarPushPara('cliente', proposta.cpf, '✅ Entrada confirmada!', 'Seu pagamento foi recebido. Acompanhe o andamento pelo app.', { url: '/consultar.html' });
                enviarPushPara('admin', 'admin', '💰 Entrada Pix confirmada (reconciliação)', `${proposta.nome || 'Cliente'} — proposta #${propostaId}.`, { url: '/painel.html' });

                const valorComissao = await gerarComissaoSeNecessario(propostaId, proposta);
                if(valorComissao !== null && proposta.funcionario_id) {
                    enviarPushPara('funcionario', proposta.funcionario_id, '💰 Comissão liberada!', `A entrada de ${proposta.nome || 'seu cliente'} foi confirmada.`, { url: '/funcionario.html' });
                }

                corrigidos++;

            } else if(tipo === 'parcela' && numeroParcela && Number(proposta.parcelas_pagas || 0) < numeroParcela) {
                await supabase.from('propostas').update({
                    parcelas_pagas: numeroParcela
                }).eq('id', propostaId);

                enviarPushPara('cliente', proposta.cpf, '✅ Parcela paga!', `Sua ${numeroParcela}ª parcela foi confirmada.`, { url: '/consultar.html' });
                enviarPushPara('admin', 'admin', '💵 Parcela Pix confirmada (reconciliação)', `${proposta.nome || 'Cliente'} — ${numeroParcela}ª parcela, proposta #${propostaId}.`, { url: '/painel.html' });

                if(proposta.funcionario_id) {
                    enviarPushPara('funcionario', proposta.funcionario_id, '📦 Parcela do seu cliente foi paga', `${proposta.nome || 'Seu cliente'} pagou a ${numeroParcela}ª parcela.`, { url: '/funcionario.html' });
                }

                corrigidos++;
            }
        }

        res.json({ sucesso: true, verificados: pagamentosAprovados.length, corrigidos });

    } catch(erro) {
        console.error('❌ Erro na reconciliação de pagamentos:', erro);
        res.json({ sucesso: false, mensagem: erro.message });
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
