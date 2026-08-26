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
    if(!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) retu
