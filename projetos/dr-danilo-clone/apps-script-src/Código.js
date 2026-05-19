/**
 * ============================================================
 * Apps Script — Webhook Kiwify + Meta CAPI (Dr. Danilo)
 * ============================================================
 *
 * Recebe webhooks da Kiwify, grava vendas em "Vendas Kiwify",
 * loga payloads em "Webhook Debug", e dispara Purchase/IC via
 * Meta Conversions API.
 *
 * Endpoints (via doGet):
 *   /exec                                         — health check
 *   /exec?action=cleanup_tests&secret=X&dry=true  — preview limpeza
 *   /exec?action=cleanup_tests&secret=X&dry=false — executa limpeza
 *   /exec?action=audit_sheets&secret=X            — auditoria abas
 *   /exec?action=delete_sheet&secret=X&name=...   — deleta aba
 *   /exec?action=delete_triggers&secret=X         — deleta triggers
 *
 * Workflow de deploy (via clasp):
 *   clasp push -f
 *   clasp version "Vx.x - descrição"
 *   clasp deploy --deploymentId AKfycbxh... --versionNumber N
 * ============================================================
 */


/**
 * ============================================================
 * WEBHOOK KIWIFY → PLANILHA
 * ============================================================
 *
 * Esta função recebe POSTs da Kiwify a cada nova venda
 * e adiciona automaticamente uma linha na aba "Vendas Kiwify".
 *
 * Configuração:
 * 1. Salve este arquivo
 * 2. Menu Implantar → Nova implantação
 * 3. Tipo: App da Web
 * 4. Executar como: Eu (sua conta)
 * 5. Quem tem acesso: Qualquer pessoa
 * 6. Implantar → copia a URL
 * 7. Cola a URL no Kiwify em Configurações → Webhooks
 * 8. Token de segurança: defina abaixo
 * ============================================================
 */

const KIWIFY_WEBHOOK_TOKEN = 'drdanilo_kiwify_2026_x9p7q3';

// ============================================================
// META CONVERSIONS API - Configuração
// ============================================================
const META_PIXEL_ID = '1501933401298971';
const META_API_VERSION = 'v21.0';
const META_EVENT_SOURCE_URL = 'https://lp.drdanilomatsunaga.com/emagrecimento/';
// Para testar antes de produção, cole o código TEST_xxxxx do Test Events.
// Em produção, deixe string vazia ''.
const META_CAPI_TEST_CODE = '';

/**
 * Token de acesso da Meta CAPI.
 *
 * ⚠️ ATENÇÃO DE SEGURANÇA:
 * O token está inline neste arquivo. Quem tiver acesso de leitura ao projeto
 * Apps Script ou ao repositório Git pode lê-lo e disparar eventos em nome
 * da conta. Recomendado mover para PropertiesService quando der:
 *   1. Editor Apps Script → Configurações do projeto
 *   2. Propriedades do script → Adicionar
 *   3. Nome: META_CAPI_TOKEN  Valor: <token>
 * Quando estiver em Properties, troque a constante abaixo por '' e o código
 * passará a ler de lá automaticamente.
 *
 * Token rotacionável a qualquer momento em:
 * Events Manager → Pixel → Configurações → API de Conversões → Gerar novo token
 */
const META_CAPI_TOKEN_INLINE = 'EAAfJAfK6BpgBRbpZCEWBDaHL3sXgJEAXR4N8oZCgwKeNrJgEzq9ELBzbBnVgOZARlvf4rKqaq9ZCTC0lNenmTUmiqoeTHKiHTdZC6Daln5lZAAotWdcEaIO7zxcBOTfdBw1knHPbLyfWbbr5zDAz38e3yp19epnWG5wxhJM00pZCBRV3URUUjpfMuoiCo2iDba7sQZDZD';

function getMetaCAPIToken() {
  return PropertiesService.getScriptProperties().getProperty('META_CAPI_TOKEN')
      || META_CAPI_TOKEN_INLINE
      || '';
}

// ============================================================
// V8.8 — SUPABASE (gravar vendas + log de eventos CAPI)
// ============================================================
// Props necessárias (Configurações do projeto → Propriedades do script):
//   SB_URL   = https://xxxxx.supabase.co
//   SB_KEY   = service_role JWT (NUNCA expor em frontend)
//   MT_TOKEN = Meta System User access token (puxador Meta API)
//   MT_ACCT  = act_xxxxxxxxx (ID da conta Meta com prefixo act_)
// ============================================================

function getSupabaseConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    url: p.getProperty('SB_URL') || '',
    key: p.getProperty('SB_KEY') || ''
  };
}

/**
 * Insere/atualiza uma venda na tabela public.vendas do Supabase.
 * Usa upsert (on_conflict=order_id) — é seguro chamar pra mesma venda 2x.
 *
 * payload: objeto com colunas da tabela vendas. order_id é OBRIGATÓRIO.
 * Retorna { success: bool, status: int, body: string }.
 */
function enviarVendaParaSupabase_(payload) {
  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) {
    Logger.log('Supabase config ausente — pulando insert venda');
    return { skipped: true, reason: 'no_supabase_config' };
  }
  if (!payload || !payload.order_id) {
    return { skipped: true, reason: 'no_order_id' };
  }

  const url = cfg.url + '/rest/v1/vendas?on_conflict=order_id';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + cfg.key,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  Logger.log('Supabase vendas upsert: ' + code + (body ? ' ' + body.slice(0, 200) : ''));
  return { success: code >= 200 && code < 300, status: code, body: body };
}

/**
 * Loga um evento CAPI (Purchase/InitiateCheckout/ViewContent) na events_capi.
 * Usado pra auditoria e dashboard de saúde do tracking.
 */
function logarEventoCAPISupabase_(payload) {
  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) return { skipped: true };
  if (!payload || !payload.event_id) return { skipped: true };

  const url = cfg.url + '/rest/v1/events_capi?on_conflict=event_id';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + cfg.key,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('Supabase events_capi falhou: ' + code + ' ' + response.getContentText().slice(0, 200));
  }
  return { success: code >= 200 && code < 300, status: code };
}

// ============================================================
// V8.8 — META MARKETING API → SUPABASE
// Puxa insights diários dos anúncios e faz upsert em public.meta_ads.
// Roda manualmente OU via trigger horário (criarTriggerMetaHorario).
// ============================================================

const META_INSIGHTS_API_VERSION = 'v21.0';

/**
 * Puxa insights da Meta Marketing API e faz upsert em public.meta_ads.
 *
 * @param {number} diasAtras default 7 — quantos dias buscar (1 = só hoje, 7 = última semana)
 * @returns {object} resumo com count, errors
 */
function puxarMetaAdsParaSupabase(diasAtras, sinceOverride, untilOverride) {
  const dias = Number(diasAtras) || 7;
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('MT_TOKEN');
  const acct = props.getProperty('MT_ACCT');

  if (!token || !acct) {
    Logger.log('MT_TOKEN ou MT_ACCT ausente — não dá pra puxar Meta');
    return { error: 'missing_credentials' };
  }

  const hoje = new Date();
  const fmt = (d) => Utilities.formatDate(d, 'GMT-03:00', 'yyyy-MM-dd');
  const since = sinceOverride ? new Date(sinceOverride) : new Date(hoje.getTime() - dias * 24 * 60 * 60 * 1000);
  const until = untilOverride ? new Date(untilOverride) : hoje;

  // V8.13: campos enriquecidos da Marketing API
  const fields = [
    'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
    'date_start',
    // Básicos
    'impressions', 'clicks', 'spend', 'ctr', 'cpm', 'cpc',
    'frequency', 'reach',
    // Cliques de qualidade
    'inline_link_clicks', 'outbound_clicks', 'unique_clicks',
    'cost_per_inline_link_click',
    // Vídeo (campos top-level)
    'video_avg_time_watched_actions',
    'video_p25_watched_actions', 'video_p50_watched_actions',
    'video_p75_watched_actions', 'video_p100_watched_actions',
    // Conversões (vêm dentro de actions/action_values)
    'actions', 'action_values',
    // Rankings Meta
    'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'
  ].join(',');

  const timeRange = JSON.stringify({ since: fmt(since), until: fmt(until) });

  // V8.15: SEM filtro de status — pega TODOS ads (incluindo pausados/encerrados)
  // pra que vendas antigas com utm_content de ads pausados bate no JOIN.

  let url = 'https://graph.facebook.com/' + META_INSIGHTS_API_VERSION + '/' + acct +
    '/insights?level=ad' +
    '&fields=' + encodeURIComponent(fields) +
    '&time_range=' + encodeURIComponent(timeRange) +
    '&time_increment=1' +
    '&limit=500' +
    '&access_token=' + encodeURIComponent(token);

  const acumulado = [];
  let pagina = 0;

  while (url && pagina < 20) {
    pagina++;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('Meta insights falhou (pag ' + pagina + '): ' + code + ' ' + resp.getContentText().slice(0, 300));
      return { error: 'meta_api_failed', status: code, body: resp.getContentText().slice(0, 500) };
    }
    const json = JSON.parse(resp.getContentText());
    if (json.data && Array.isArray(json.data)) {
      acumulado.push.apply(acumulado, json.data);
    }
    url = json.paging && json.paging.next ? json.paging.next : null;
  }

  Logger.log('Meta insights: ' + acumulado.length + ' linhas em ' + pagina + ' pgs');
  if (acumulado.length === 0) return { success: true, count: 0 };

  // Transforma payload Meta → formato meta_ads do Supabase
  const linhas = acumulado.map(function (it) {
    const actions = it.actions || [];
    const actionValues = it.action_values || [];
    const findAction = function (type) {
      const a = actions.find(function (x) { return x.action_type === type; });
      return a ? Number(a.value) || 0 : 0;
    };
    const findActionValue = function (type) {
      const a = actionValues.find(function (x) { return x.action_type === type; });
      return a ? Number(a.value) || 0 : 0;
    };
    // Pega valor de array de actions com .value somado (Meta às vezes manda array)
    const sumArrayValue = function (arr) {
      if (!arr || !arr.length) return 0;
      return arr.reduce(function (sum, x) { return sum + (Number(x.value) || 0); }, 0);
    };

    // Outbound clicks vem como array com action_type
    const outboundClicks = (it.outbound_clicks || []).reduce(function (s, x) {
      return s + (Number(x.value) || 0);
    }, 0);

    return {
      ad_id: String(it.ad_id),
      date: it.date_start,
      ad_name: it.ad_name || null,
      adset_id: String(it.adset_id || ''),
      adset_name: it.adset_name || null,
      campaign_id: String(it.campaign_id || ''),
      campaign_name: it.campaign_name || null,
      // Básicos
      impressions: Number(it.impressions) || 0,
      clicks: Number(it.clicks) || 0,
      spend: Number(it.spend) || 0,
      // ctr vem como porcentagem (ex: 2.34 = 2.34%). numeric(6,4) aceita até 99.9999.
      // Ads novos com 1 impressão podem ter CTR > 100 — clampar pra não travar o lote inteiro.
      ctr: Math.min(Number(it.ctr) || 0, 99.9999),
      cpm: Number(it.cpm) || 0,
      cpc: Number(it.cpc) || 0,
      frequency: Number(it.frequency) || 0,
      reach: Number(it.reach) || 0,
      // Cliques qualidade
      inline_link_clicks: Number(it.inline_link_clicks) || 0,
      outbound_clicks: outboundClicks,
      unique_clicks: Number(it.unique_clicks) || 0,
      cost_per_inline_link_click: it.cost_per_inline_link_click
        ? (Array.isArray(it.cost_per_inline_link_click)
            ? Number(it.cost_per_inline_link_click[0]?.value) || 0
            : Number(it.cost_per_inline_link_click) || 0)
        : null,
      // Conversões
      view_content: findAction('view_content'),
      initiate_checkout: findAction('initiate_checkout'),
      purchase_meta: findAction('purchase') || findAction('omni_purchase'),
      purchase_value_meta: findActionValue('purchase') || findActionValue('omni_purchase'),
      // Engajamento
      post_engagement: findAction('post_engagement'),
      post_reactions: findAction('post_reaction'),
      comments: findAction('comment'),
      post_share: findAction('post'),
      // Vídeo
      video_p25: sumArrayValue(it.video_p25_watched_actions),
      video_p50: sumArrayValue(it.video_p50_watched_actions),
      video_p75: sumArrayValue(it.video_p75_watched_actions),
      video_p100: sumArrayValue(it.video_p100_watched_actions),
      thruplays: findAction('video_view'),
      video_avg_time_watched: it.video_avg_time_watched_actions && it.video_avg_time_watched_actions[0]
        ? Number(it.video_avg_time_watched_actions[0].value) || 0
        : null,
      // Rankings (texto: ABOVE_AVERAGE / AVERAGE / BELOW_AVERAGE / etc)
      quality_ranking: it.quality_ranking || null,
      engagement_rate_ranking: it.engagement_rate_ranking || null,
      conversion_rate_ranking: it.conversion_rate_ranking || null
    };
  });

  // Manda em lotes de 100 pra não estourar payload size
  const cfg = getSupabaseConfig_();
  const upsertUrl = cfg.url + '/rest/v1/meta_ads?on_conflict=ad_id,date';
  let inseridos = 0;
  let erros = 0;

  for (let i = 0; i < linhas.length; i += 100) {
    const lote = linhas.slice(i, i + 100);
    const resp = UrlFetchApp.fetch(upsertUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(lote),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      inseridos += lote.length;
    } else {
      erros++;
      Logger.log('Upsert meta_ads lote ' + i + ' falhou: ' + code + ' ' + resp.getContentText().slice(0, 200));
    }
  }

  Logger.log('Meta → Supabase: ' + inseridos + '/' + linhas.length + ' inseridos | erros=' + erros);
  return { success: true, count: inseridos, total: linhas.length, errors: erros, pages: pagina };
}

/**
 * V8.13 — Puxa metadados dos anúncios (status, budget, creative) e faz upsert em meta_ads_metadata.
 * Chamada separada à API: /act_X/ads (não /insights).
 * Roda a cada 1h (status muda pouco — não precisa 15min).
 */
function puxarMetaAdsMetadata() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('MT_TOKEN');
  const acct = props.getProperty('MT_ACCT');

  if (!token || !acct) {
    Logger.log('MT_TOKEN ou MT_ACCT ausente');
    return { error: 'missing_credentials' };
  }

  const fields = [
    'id', 'name', 'adset_id', 'campaign_id',
    'status', 'effective_status', 'configured_status',
    'created_time', 'updated_time',
    'creative{id,thumbnail_url,image_url,video_id,title,body,call_to_action_type,object_story_spec,object_story_id,link_url}'
  ].join(',');

  // V8.15: removido filtro ACTIVE — pega TODOS ads (incluindo pausados/encerrados)
  // pra que vendas antigas batam no JOIN com seus ad_ids originais

  let url = 'https://graph.facebook.com/' + META_INSIGHTS_API_VERSION + '/' + acct +
    '/ads?fields=' + encodeURIComponent(fields) +
    '&limit=200' +
    '&access_token=' + encodeURIComponent(token);

  const acumulado = [];
  let pagina = 0;
  while (url && pagina < 10) {
    pagina++;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('Meta ads metadata falhou (pag ' + pagina + '): ' + code + ' ' + resp.getContentText().slice(0, 300));
      return { error: 'meta_api_failed', status: code };
    }
    const json = JSON.parse(resp.getContentText());
    if (json.data && Array.isArray(json.data)) {
      acumulado.push.apply(acumulado, json.data);
    }
    url = json.paging && json.paging.next ? json.paging.next : null;
  }

  Logger.log('Meta ads metadata: ' + acumulado.length + ' anúncios em ' + pagina + ' pgs');

  // Pra cada ad, pega adset/campaign info adicional via 1 chamada batch
  // (preferimos manter simples — pegamos só o que veio direto)
  const linhas = acumulado.map(function (it) {
    const creative = it.creative || {};
    const objStory = creative.object_story_spec || {};
    const linkData = objStory.link_data || {};
    const videoData = objStory.video_data || {};

    return {
      ad_id: String(it.id),
      ad_name: it.name || null,
      adset_id: String(it.adset_id || ''),
      campaign_id: String(it.campaign_id || ''),
      status: it.status || null,
      effective_status: it.effective_status || null,
      configured_status: it.configured_status || null,
      created_time: it.created_time || null,
      updated_time: it.updated_time || null,
      creative_id: creative.id || null,
      thumbnail_url: creative.thumbnail_url || null,
      image_url: creative.image_url || linkData.picture || null,
      video_id: creative.video_id || videoData.video_id || null,
      title: creative.title || linkData.name || videoData.title || null,
      body: creative.body || linkData.message || linkData.description || videoData.message || null,
      call_to_action_type: creative.call_to_action_type
        || (linkData.call_to_action && linkData.call_to_action.type)
        || (videoData.call_to_action && videoData.call_to_action.type)
        || null,
      link_url: creative.link_url || linkData.link || null,
      updated_at: new Date().toISOString()
    };
  });

  if (linhas.length === 0) return { success: true, count: 0 };

  // Upsert em batch
  const cfg = getSupabaseConfig_();
  const upsertUrl = cfg.url + '/rest/v1/meta_ads_metadata?on_conflict=ad_id';
  let inseridos = 0;
  let erros = 0;

  for (let i = 0; i < linhas.length; i += 100) {
    const lote = linhas.slice(i, i + 100);
    const resp = UrlFetchApp.fetch(upsertUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(lote),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      inseridos += lote.length;
    } else {
      erros++;
      Logger.log('Upsert metadata lote ' + i + ' falhou: ' + code + ' ' + resp.getContentText().slice(0, 200));
    }
  }

  Logger.log('Meta metadata → Supabase: ' + inseridos + '/' + linhas.length + ' | erros=' + erros);
  return { success: true, count: inseridos, total: linhas.length, errors: erros };
}

/**
 * Cria trigger horário pra metadata (roda 1x por hora).
 */
function criarTriggerMetaMetadata() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'puxarMetaAdsMetadata'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('puxarMetaAdsMetadata')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('Trigger horário criado pra puxarMetaAdsMetadata');
  return { success: true };
}

/**
 * Teste rápido — puxa metadata uma vez.
 */
function testarMetadataMeta() {
  const r = puxarMetaAdsMetadata();
  Logger.log('Resultado metadata: ' + JSON.stringify(r));
  return r;
}

/**
 * Cria trigger pra rodar puxarMetaAdsParaSupabase a cada 15 minutos.
 * Roda 1x manualmente pra ativar o cron.
 * 15min é o intervalo mais baixo viável: Apps Script aceita 1/5/10/15/30 min,
 * e a Meta Marketing API tem ~15-20min de delay nos dados mesmo.
 */
function criarTriggerMetaHorario() {
  // Remove triggers antigos da mesma função (evita duplicação)
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'puxarMetaAdsParaSupabase'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('puxarMetaAdsParaSupabase')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log('Trigger de 15min criado pra puxarMetaAdsParaSupabase');
  return { success: true, intervalMinutes: 15 };
}

/**
 * Remove o trigger horário (caso queira parar o pull).
 */
function removerTriggerMetaHorario() {
  const removed = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'puxarMetaAdsParaSupabase'; });
  removed.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Removidos ' + removed.length + ' triggers');
  return { removed: removed.length };
}

/**
 * V8.15 — Puxa HISTÓRICO AMPLO Meta (90 dias) incluindo ads pausados/encerrados.
 * Roda 1x manualmente pra rebuildar tabela meta_ads + meta_ads_metadata com TUDO,
 * fazendo vendas antigas baterem no JOIN.
 */
function puxarHistoricoMetaAmplo90Dias() {
  Logger.log('Puxando histórico 90 dias em chunks de 7 dias...');
  const fmtD = (d) => Utilities.formatDate(d, 'GMT-03:00', 'yyyy-MM-dd');
  const sub = (d, dias) => new Date(d.getTime() - dias * 86400000);
  const hoje = new Date();
  const resultados = [];
  const CHUNK = 7;
  const TOTAL = 91; // cobre 13 semanas completas

  for (var offset = 0; offset < TOTAL; offset += CHUNK) {
    const until = sub(hoje, offset);
    const since = sub(hoje, offset + CHUNK - 1);
    const label = 'dias ' + offset + '–' + (offset + CHUNK - 1) + ' atrás';
    Logger.log('Chunk ' + label);
    const r = puxarMetaAdsParaSupabase(null, fmtD(since), fmtD(until));
    Logger.log('Chunk ' + label + ': ' + JSON.stringify(r));
    resultados.push({ label: label, result: r });
    if (r.error) {
      Logger.log('Chunk falhou em ' + label + ', continuando...');
    }
    if (offset + CHUNK < TOTAL) Utilities.sleep(3000);
  }

  Logger.log('Puxando metadata Meta de TODOS ads...');
  const rm = puxarMetaAdsMetadata();
  Logger.log('Metadata: ' + JSON.stringify(rm));

  const totalInseridos = resultados.reduce(function(s, c) { return s + ((c.result && c.result.count) || 0); }, 0);
  const totalErros = resultados.filter(function(c) { return c.result && c.result.error; }).length;
  Logger.log('RESUMO: ' + totalInseridos + ' linhas inseridas, ' + totalErros + ' chunks com erro');

  return { chunks: resultados.length, inseridos: totalInseridos, erros: totalErros, metadata: rm };
}

/**
 * Sync diário: refresca os últimos 30 dias de dados Meta em chunks de 7 dias.
 * Corrige discrepâncias causadas por revisões retroativas da Meta (±2-5%).
 * Chamado 1x/dia pelo trigger criado em criarTriggerMetaDiario().
 */
function syncMetaHistorico30Dias() {
  Logger.log('syncMetaHistorico30Dias — iniciando refresh de 30 dias...');
  const fmtD = (d) => Utilities.formatDate(d, 'GMT-03:00', 'yyyy-MM-dd');
  const sub = (d, dias) => new Date(d.getTime() - dias * 86400000);
  const hoje = new Date();
  const resultados = [];
  const CHUNK = 7;
  const TOTAL = 30;

  for (var offset = 0; offset < TOTAL; offset += CHUNK) {
    const until = sub(hoje, offset);
    const since = sub(hoje, Math.min(offset + CHUNK - 1, TOTAL - 1));
    const label = 'dias ' + offset + '–' + Math.min(offset + CHUNK - 1, TOTAL - 1) + ' atrás';
    Logger.log('Chunk ' + label);
    const r = puxarMetaAdsParaSupabase(null, fmtD(since), fmtD(until));
    resultados.push({ label: label, result: r });
    if (r && r.error) Logger.log('Chunk falhou em ' + label + ': ' + JSON.stringify(r.error));
    if (offset + CHUNK < TOTAL) Utilities.sleep(3000);
  }

  const totalInseridos = resultados.reduce(function(s, c) { return s + ((c.result && c.result.count) || 0); }, 0);
  const totalErros = resultados.filter(function(c) { return c.result && c.result.error; }).length;
  Logger.log('syncMetaHistorico30Dias RESUMO: ' + totalInseridos + ' linhas, ' + totalErros + ' erros');
  return { chunks: resultados.length, inseridos: totalInseridos, erros: totalErros };
}

/**
 * Cria trigger diário pra rodar syncMetaHistorico30Dias às 3h BRT.
 * Execute este helper 1x manualmente para ativar o cron.
 */
function criarTriggerMetaDiario() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'syncMetaHistorico30Dias'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('syncMetaHistorico30Dias')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .inTimezone('America/Sao_Paulo')
    .create();

  Logger.log('Trigger diário criado: syncMetaHistorico30Dias às 3h BRT');
  return { success: true };
}

/**
 * Teste rápido: puxa só HOJE (1 dia) e mostra resumo.
 * Bom pra rodar manualmente do editor pra validar antes do trigger.
 */
function testarPuxadorMetaHoje() {
  const r = puxarMetaAdsParaSupabase(1);
  Logger.log('Resultado puxador Meta hoje: ' + JSON.stringify(r));
  return r;
}

/**
 * V8.10 — Migra TODAS as vendas históricas da aba "Vendas Kiwify" pro Supabase.
 * Roda manualmente UMA VEZ.
 *
 * Layout esperado da aba (colunas A-M):
 *   A=Data | B=campaign_id | C=adset_id | D=ad_id | E=Valor | F=- | G=- |
 *   H=Source | I=Produto | J=Nome | K=Email | L=Status | M=Order ID
 *
 * Idempotente — usa upsert por order_id.
 */
function migrarVendasHistoricasSheetsParaSupabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName('Vendas Kiwify');
  if (!aba) {
    Logger.log('Aba "Vendas Kiwify" não encontrada');
    return { error: 'sheet_not_found' };
  }
  const lastRow = aba.getLastRow();
  if (lastRow < 2) {
    Logger.log('Aba vazia (só header) — nada pra migrar');
    return { success: true, count: 0 };
  }

  const rows = aba.getRange(2, 1, lastRow - 1, 13).getValues();
  Logger.log('Lendo ' + rows.length + ' linhas da aba "Vendas Kiwify"');

  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) {
    Logger.log('SB_URL/SB_KEY ausente');
    return { error: 'no_supabase_config' };
  }

  const payloads = [];
  let semOrderId = 0;
  rows.forEach(function (row, idx) {
    const dataVenda = row[0];
    const utmCampaign = row[1];
    const utmMedium = row[2];
    const utmContent = row[3];
    const valor = Number(row[4]) || 0;
    const utmSource = row[7];
    const produto = row[8];
    const nome = row[9];
    const email = row[10];
    const status = String(row[11] || '').toLowerCase();
    const orderId = String(row[12] || '').trim();

    if (!orderId) { semOrderId++; return; }
    if (orderId.indexOf('TEST_') === 0 || orderId.indexOf('V8') === 0) return; // skip linhas de teste

    payloads.push({
      order_id: orderId,
      created_at: dataVenda instanceof Date ? dataVenda.toISOString() : new Date().toISOString(),
      valor: valor,
      moeda: 'BRL',
      utm_source: utmSource || null,
      utm_campaign: utmCampaign || null,
      utm_medium: utmMedium || null,
      utm_content: utmContent || null,
      cliente_nome: nome || null,
      cliente_email: email || null,
      produto_nome: produto || null,
      status: /paid|approved|aprovad/.test(status) ? 'paid' : status
    });
  });

  Logger.log('Payloads válidos: ' + payloads.length + ' (' + semOrderId + ' sem order_id ignoradas)');

  if (payloads.length === 0) return { success: true, count: 0 };

  // Envia em lotes de 100
  const upsertUrl = cfg.url + '/rest/v1/vendas?on_conflict=order_id';
  let inseridos = 0;
  let erros = 0;
  for (let i = 0; i < payloads.length; i += 100) {
    const lote = payloads.slice(i, i + 100);
    const resp = UrlFetchApp.fetch(upsertUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(lote),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      inseridos += lote.length;
    } else {
      erros++;
      Logger.log('Lote ' + i + ' falhou: ' + code + ' ' + resp.getContentText().slice(0, 300));
    }
  }

  Logger.log('Migração concluída: ' + inseridos + '/' + payloads.length + ' vendas | erros=' + erros);
  return { success: true, count: inseridos, total: payloads.length, errors: erros, ignoradas: semOrderId };
}

// ============================================================
// V8.11 — TRACKING DE LEADS DE CONSULTA
// Endpoint público chamado pelo webhook do form WordPress/Elementor.
// Grava em public.leads_consultas + dispara Meta CAPI Lead.
// ============================================================
// V8.16 — RELATÓRIO PDF SEMANAL (top criativos + métricas)
// Roda toda segunda 8h via trigger
// Salva PDF na pasta Drive "Relatórios Dr Danilo" + envia email
// ============================================================

const RELATORIO_EMAIL_DESTINATARIO = 'eduardosocialmedia2000@gmail.com';
const RELATORIO_PASTA_NOME = 'Relatórios Dashboard Dr Danilo';

/**
 * Função principal — gera relatório semanal completo
 * Roda manualmente OU via trigger semanal segunda 8h
 */
function gerarRelatorioSemanal() {
  const hoje = new Date();
  const seteDiasAtras = new Date(hoje.getTime() - 7 * 24 * 60 * 60 * 1000);
  const quatorzeDiasAtras = new Date(hoje.getTime() - 14 * 24 * 60 * 60 * 1000);

  const fmtDate = (d) => Utilities.formatDate(d, 'GMT-03:00', 'yyyy-MM-dd');
  const fmtDateBR = (d) => Utilities.formatDate(d, 'GMT-03:00', 'dd/MM/yyyy');
  const periodo = fmtDateBR(seteDiasAtras) + ' a ' + fmtDateBR(hoje);

  Logger.log('Gerando relatório semanal: ' + periodo);

  // 1. Busca dados via Supabase REST
  const dados = puxarDadosRelatorio_(fmtDate(seteDiasAtras), fmtDate(hoje), fmtDate(quatorzeDiasAtras));
  if (dados.error) {
    Logger.log('Erro ao puxar dados: ' + dados.error);
    return { error: dados.error };
  }

  // 2. Cria Google Doc temporário com o relatório formatado
  const doc = montarDocRelatorio_(dados, periodo);
  Logger.log('Doc criado: ' + doc.getUrl());

  // 3. Exporta o Doc como PDF
  const pdfBlob = doc.getAs(MimeType.PDF);
  const nomeArquivo = 'Relatorio_DrDanilo_' + fmtDate(hoje) + '.pdf';
  pdfBlob.setName(nomeArquivo);

  // 4. Salva o PDF na pasta Drive (cria pasta se não existir)
  const pasta = obterOuCriarPasta_(RELATORIO_PASTA_NOME);
  const pdfArquivo = pasta.createFile(pdfBlob);
  Logger.log('PDF salvo em: ' + pdfArquivo.getUrl());

  // 5. Apaga o Doc temporário (mantém só o PDF)
  DriveApp.getFileById(doc.getId()).setTrashed(true);

  // 6. Envia email com PDF anexo
  const corpoEmail = montarCorpoEmail_(dados, periodo, pdfArquivo.getUrl());
  MailApp.sendEmail({
    to: RELATORIO_EMAIL_DESTINATARIO,
    subject: '📊 Relatório Semanal Dr. Danilo — ' + periodo,
    htmlBody: corpoEmail,
    attachments: [pdfBlob]
  });

  Logger.log('Email enviado pra ' + RELATORIO_EMAIL_DESTINATARIO);

  return {
    success: true,
    periodo: periodo,
    pdf_url: pdfArquivo.getUrl(),
    pdf_id: pdfArquivo.getId(),
    pasta_url: pasta.getUrl()
  };
}

/**
 * Busca dados do Supabase pra montar relatório
 */
function puxarDadosRelatorio_(dataInicio, dataFim, dataInicioSemanaAnterior) {
  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) return { error: 'no_supabase_config' };

  const headers = { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key };

  try {
    // KPIs gerais
    const kpisResp = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/vw_kpis_overview?date=gte.' + dataInicio + '&date=lte.' + dataFim,
      { headers: headers, muteHttpExceptions: true }
    );
    const kpis = JSON.parse(kpisResp.getContentText());

    // KPIs da semana anterior (pra calcular diff)
    const kpisAntResp = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/vw_kpis_overview?date=gte.' + dataInicioSemanaAnterior + '&date=lt.' + dataInicio,
      { headers: headers, muteHttpExceptions: true }
    );
    const kpisAnteriores = JSON.parse(kpisAntResp.getContentText());

    // Performance por ad (pra top criativos)
    const perfResp = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/vw_performance_by_ad?date=gte.' + dataInicio + '&date=lte.' + dataFim +
        '&spend=gt.0&limit=200',
      { headers: headers, muteHttpExceptions: true }
    );
    const performance = JSON.parse(perfResp.getContentText());

    // Vendas por fonte (pra ver canais)
    const fontesResp = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/vw_vendas_por_fonte?date=gte.' + dataInicio + '&date=lte.' + dataFim,
      { headers: headers, muteHttpExceptions: true }
    );
    const fontes = JSON.parse(fontesResp.getContentText());

    return { kpis, kpisAnteriores, performance, fontes };
  } catch (err) {
    return { error: err.toString() };
  }
}

/**
 * Cria Google Doc estruturado com o relatório
 */
function montarDocRelatorio_(dados, periodo) {
  const doc = DocumentApp.create('Relatório Dr. Danilo — ' + new Date().toISOString());
  const body = doc.getBody();

  // Style: limpa default
  body.clear();

  // ===== CABEÇALHO =====
  const titulo = body.appendParagraph('📊 Relatório Semanal — Dr. Danilo Matsunaga');
  titulo.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  titulo.editAsText().setBold(true).setFontSize(24);

  const subTitulo = body.appendParagraph('Período: ' + periodo);
  subTitulo.editAsText().setForegroundColor('#666666').setFontSize(12);

  body.appendParagraph('');

  // ===== RESUMO EXECUTIVO =====
  body.appendParagraph('Resumo Executivo').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // Calcula totais
  const tot = somarKpis_(dados.kpis);
  const totAnt = somarKpis_(dados.kpisAnteriores);

  const tabResumo = body.appendTable([
    ['Métrica', 'Esta semana', 'Semana anterior', 'Δ'],
    ['Investimento total', fmtMoeda_(tot.spend), fmtMoeda_(totAnt.spend), calcDiff_(tot.spend, totAnt.spend)],
    ['Vendas Kiwify', tot.vendas + ' vendas', totAnt.vendas + ' vendas', calcDiff_(tot.vendas, totAnt.vendas)],
    ['Receita Kiwify', fmtMoeda_(tot.receita_total), fmtMoeda_(totAnt.receita_total), calcDiff_(tot.receita_total, totAnt.receita_total)],
    ['Cliques WhatsApp', tot.cliques_wa + ' cliques', totAnt.cliques_wa + ' cliques', calcDiff_(tot.cliques_wa, totAnt.cliques_wa)],
    ['ROAS Geral', (tot.spend > 0 ? (tot.receita_total / tot.spend).toFixed(2) + 'x' : '—'),
                  (totAnt.spend > 0 ? (totAnt.receita_total / totAnt.spend).toFixed(2) + 'x' : '—'),
                  '—']
  ]);
  tabResumo.getRow(0).editAsText().setBold(true);

  body.appendParagraph('');

  // ===== TOP CRIATIVOS INFOPRODUTO =====
  body.appendParagraph('🏆 Top Criativos — Infoproduto').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const topInfo = (dados.performance || [])
    .filter(p => p.categoria === 'infoproduto' && p.spend > 0)
    .sort((a, b) => (b.roas || 0) - (a.roas || 0))
    .slice(0, 5);

  if (topInfo.length > 0) {
    const headersInfo = ['Anúncio', 'Investido', 'Vendas', 'Receita', 'ROAS', 'CTR'];
    const linhasInfo = topInfo.map(p => [
      truncarTexto_(p.ad_name, 40),
      fmtMoeda_(p.spend),
      String(p.vendas_count || 0),
      fmtMoeda_(p.receita || 0),
      (p.roas || 0).toFixed(2) + 'x',
      (p.ctr || 0).toFixed(2) + '%'
    ]);
    const tabInfo = body.appendTable([headersInfo].concat(linhasInfo));
    tabInfo.getRow(0).editAsText().setBold(true);
  } else {
    body.appendParagraph('Sem dados de Infoproduto no período.').editAsText().setItalic(true);
  }

  body.appendParagraph('');

  // ===== TOP CRIATIVOS CONSULTAS =====
  body.appendParagraph('🏆 Top Criativos — Consultas').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const topCons = (dados.performance || [])
    .filter(p => p.categoria === 'consultas' && p.spend > 0)
    .sort((a, b) => (b.clicks || 0) / Math.max(b.spend, 1) - (a.clicks || 0) / Math.max(a.spend, 1))
    .slice(0, 5);

  if (topCons.length > 0) {
    const headersCons = ['Anúncio', 'Investido', 'Cliques', 'Custo/Clique', 'CTR', 'Frequency'];
    const linhasCons = topCons.map(p => [
      truncarTexto_(p.ad_name, 40),
      fmtMoeda_(p.spend),
      String(p.clicks || 0),
      p.clicks > 0 ? fmtMoeda_(p.spend / p.clicks) : '—',
      (p.ctr || 0).toFixed(2) + '%',
      (p.frequency || 0).toFixed(2)
    ]);
    const tabCons = body.appendTable([headersCons].concat(linhasCons));
    tabCons.getRow(0).editAsText().setBold(true);
  } else {
    body.appendParagraph('Sem dados de Consultas no período.').editAsText().setItalic(true);
  }

  body.appendParagraph('');

  // ===== VENDAS POR FONTE =====
  body.appendParagraph('📍 Vendas por Fonte').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const fontesAgg = {};
  (dados.fontes || []).forEach(f => {
    if (!fontesAgg[f.fonte]) fontesAgg[f.fonte] = { vendas: 0, receita: 0 };
    fontesAgg[f.fonte].vendas += f.vendas || 0;
    fontesAgg[f.fonte].receita += Number(f.receita) || 0;
  });

  if (Object.keys(fontesAgg).length > 0) {
    const fontesLinhas = [['Fonte', 'Vendas', 'Receita']];
    Object.keys(fontesAgg).forEach(k => {
      fontesLinhas.push([k, String(fontesAgg[k].vendas), fmtMoeda_(fontesAgg[k].receita)]);
    });
    const tabFontes = body.appendTable(fontesLinhas);
    tabFontes.getRow(0).editAsText().setBold(true);
  } else {
    body.appendParagraph('Sem dados de fontes no período.').editAsText().setItalic(true);
  }

  body.appendParagraph('');

  // ===== INSIGHTS AUTOMÁTICOS =====
  body.appendParagraph('💡 Insights Automáticos').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const insights = gerarInsights_(dados, tot, totAnt, topInfo, topCons);
  insights.forEach(insight => {
    const p = body.appendListItem(insight);
    p.editAsText().setFontSize(11);
  });

  body.appendParagraph('');

  // ===== FOOTER =====
  body.appendParagraph('').appendHorizontalRule();
  const footer = body.appendParagraph('Relatório gerado automaticamente pelo dashboard.');
  footer.editAsText().setItalic(true).setFontSize(9).setForegroundColor('#999999');
  body.appendParagraph('Acesse o dashboard ao vivo: https://drdanilo-metrics-hub.lovable.app')
    .editAsText().setFontSize(9).setForegroundColor('#999999');

  doc.saveAndClose();
  return doc;
}

function somarKpis_(kpis) {
  const tot = { spend: 0, vendas: 0, receita_total: 0, cliques_wa: 0, leads_form: 0 };
  (kpis || []).forEach(k => {
    tot.spend += Number(k.spend) || 0;
    tot.vendas += Number(k.vendas_total) || 0;
    tot.receita_total += Number(k.receita_total) || 0;
    tot.cliques_wa += Number(k.cliques_wa) || 0;
    tot.leads_form += Number(k.leads_form) || 0;
  });
  return tot;
}

function fmtMoeda_(n) {
  if (n === null || n === undefined) return 'R$ 0,00';
  return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calcDiff_(atual, anterior) {
  if (!anterior || anterior === 0) return atual > 0 ? '⬆ novo' : '—';
  const pct = ((atual - anterior) / anterior) * 100;
  const sinal = pct >= 0 ? '⬆' : '⬇';
  return sinal + ' ' + Math.abs(pct).toFixed(1) + '%';
}

function truncarTexto_(s, n) {
  if (!s) return '—';
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

function gerarInsights_(dados, tot, totAnt, topInfo, topCons) {
  const insights = [];

  // Insight 1: tendência geral
  if (totAnt.spend > 0) {
    const diffSpend = ((tot.spend - totAnt.spend) / totAnt.spend) * 100;
    if (diffSpend > 20) insights.push('Investimento aumentou ' + diffSpend.toFixed(0) + '% vs semana anterior — está escalando.');
    if (diffSpend < -20) insights.push('Investimento caiu ' + Math.abs(diffSpend).toFixed(0) + '% — verificar se foi proposital.');
  }

  // Insight 2: ROAS
  if (tot.spend > 0) {
    const roas = tot.receita_total / tot.spend;
    if (roas < 0.5) insights.push('ROAS abaixo de 0.5x — possível prejuízo, revisar criativos e públicos.');
    if (roas > 1.5) insights.push('ROAS acima de 1.5x — performance saudável. Considerar escalar 20%.');
  }

  // Insight 3: Top performer
  if (topInfo.length > 0) {
    const top = topInfo[0];
    insights.push('Top criativo Infoproduto: "' + truncarTexto_(top.ad_name, 50) + '" com ROAS ' +
      (top.roas || 0).toFixed(2) + 'x. Considere duplicar ou criar variações.');
  }

  if (topCons.length > 0) {
    const top = topCons[0];
    const cpc = top.clicks > 0 ? top.spend / top.clicks : 0;
    insights.push('Top criativo Consultas: "' + truncarTexto_(top.ad_name, 50) + '" com R$ ' +
      cpc.toFixed(2) + ' por clique. Forte candidato a escalar.');
  }

  // Insight 4: Frequency alto
  const ftLatos = (dados.performance || []).filter(p => p.frequency > 3);
  if (ftLatos.length > 0) {
    insights.push(ftLatos.length + ' anúncios com Frequency > 3 — fadiga de criativo iminente. Gerar variações.');
  }

  if (insights.length === 0) {
    insights.push('Sem alertas relevantes nesta semana — performance estável.');
  }

  return insights;
}

function obterOuCriarPasta_(nome) {
  const pastas = DriveApp.getFoldersByName(nome);
  if (pastas.hasNext()) return pastas.next();
  return DriveApp.createFolder(nome);
}

function montarCorpoEmail_(dados, periodo, pdfUrl) {
  const tot = somarKpis_(dados.kpis);
  const roas = tot.spend > 0 ? (tot.receita_total / tot.spend).toFixed(2) : '0.00';
  return '<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">' +
    '<h2 style="color: #1d1d1f;">📊 Relatório Dr. Danilo — ' + periodo + '</h2>' +
    '<p style="color: #6e6e73;">Resumo da semana:</p>' +
    '<ul style="line-height: 1.8;">' +
      '<li><b>Investimento:</b> ' + fmtMoeda_(tot.spend) + '</li>' +
      '<li><b>Receita Kiwify:</b> ' + fmtMoeda_(tot.receita_total) + ' (' + tot.vendas + ' vendas)</li>' +
      '<li><b>Cliques WhatsApp:</b> ' + tot.cliques_wa + '</li>' +
      '<li><b>ROAS:</b> ' + roas + 'x</li>' +
    '</ul>' +
    '<p>O relatório completo está em anexo (PDF) e também disponível em:</p>' +
    '<p><a href="' + pdfUrl + '" style="color: #0071e3;">Ver PDF no Drive</a></p>' +
    '<p><a href="https://drdanilo-metrics-hub.lovable.app" style="color: #0071e3;">Abrir dashboard ao vivo</a></p>' +
    '<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">' +
    '<p style="font-size: 12px; color: #999;">Relatório gerado automaticamente toda segunda-feira às 8h.</p>' +
  '</div>';
}

/**
 * Cria trigger semanal pra rodar gerarRelatorioSemanal toda segunda 8h
 */
function criarTriggerRelatorioSemanal() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'gerarRelatorioSemanal'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('gerarRelatorioSemanal')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();

  Logger.log('Trigger criado: gerarRelatorioSemanal toda segunda 8h');
  return { success: true };
}

/**
 * Teste manual: gera relatório agora pra validar o fluxo
 */
function testarRelatorioSemanal() {
  const r = gerarRelatorioSemanal();
  Logger.log('Resultado: ' + JSON.stringify(r));
  return r;
}

// ============================================================

/**
 * Recebe lead via GET ou POST com params:
 *   - nome, email, telefone, especialidade, mensagem (do form)
 *   - utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid (do cookie/URL)
 *   - fbp, fbc (do JS browser ou GTM)
 *   - lp_url (URL atual)
 *   - token (segurança — checa contra LEAD_WEBHOOK_TOKEN)
 *
 * Retorna JSON { success, lead_id, capi }.
 *
 * Idempotente: dedup_key na tabela evita duplicação dentro da mesma hora.
 */
function handleLeadConsulta_(params, e) {
  const ADMIN_SECRET = 'drdanilo_kiwify_2026_x9p7q3';
  const tokenRecebido = params.token || '';
  if (tokenRecebido !== ADMIN_SECRET) {
    return { success: false, error: 'token_invalid' };
  }

  // Aceita também body POST (Elementor às vezes manda form-encoded)
  let bodyData = {};
  if (e && e.postData && e.postData.contents) {
    try {
      const ct = (e.postData.type || '').toLowerCase();
      if (ct.indexOf('json') >= 0) {
        bodyData = JSON.parse(e.postData.contents);
      } else if (ct.indexOf('form') >= 0) {
        e.postData.contents.split('&').forEach(function (pair) {
          const kv = pair.split('=');
          bodyData[decodeURIComponent(kv[0] || '')] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
        });
      }
    } catch (_e) {}
  }

  const get = function (k) {
    return bodyData[k] || params[k] || '';
  };

  const nome = get('nome') || get('name') || get('full_name') || '';
  const email = get('email') || '';
  const telefone = (get('telefone') || get('phone') || get('whatsapp') || '').replace(/\D/g, '');
  const especialidade = get('especialidade') || get('specialty') || '';
  const mensagem = get('mensagem') || get('message') || '';
  const tipo = (get('tipo') || 'form').toLowerCase();   // V8.14: 'form' | 'clique_wa'

  // V8.14: se tipo=clique_wa, NÃO exige email/telefone — só fbp/fbc/utm pra atribuição anônima
  if (tipo !== 'clique_wa' && !email && !telefone) {
    return { success: false, error: 'no_contact_info' };
  }

  const utm_source = get('utm_source') || null;
  const utm_medium = get('utm_medium') || null;
  const utm_campaign = get('utm_campaign') || null;
  const utm_content = get('utm_content') || null;
  const utm_term = get('utm_term') || null;
  const fbclid = get('fbclid') || null;
  const fbp = get('fbp') || null;
  const fbc = get('fbc') || null;
  const lp_url = get('lp_url') || get('page_url') || null;

  // Grava no Supabase
  const cfg = getSupabaseConfig_();
  const leadPayload = {
    nome: nome || (tipo === 'clique_wa' ? '(clique WhatsApp)' : null),
    email: email || null,
    telefone: telefone || null,
    especialidade: especialidade || null,
    mensagem: mensagem || null,
    utm_source: utm_source,
    utm_medium: utm_medium,
    utm_campaign: utm_campaign,
    utm_content: utm_content,
    utm_term: utm_term,
    fbclid: fbclid,
    fbp: fbp,
    fbc: fbc,
    lp_url: lp_url,
    user_agent: get('user_agent') || null,
    status: tipo === 'clique_wa' ? 'clique_wa' : 'novo'  // V8.14: marca clique anônimo
  };

  let leadId = null;
  let supaResult = null;
  try {
    const resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/leads_consultas', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Prefer': 'return=representation'
      },
      payload: JSON.stringify(leadPayload),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      const arr = JSON.parse(resp.getContentText());
      leadId = (arr[0] && arr[0].id) || null;
      supaResult = { success: true, lead_id: leadId };
    } else {
      supaResult = { success: false, status: code, body: resp.getContentText().slice(0, 300) };
      Logger.log('Insert lead falhou: ' + supaResult.body);
    }
  } catch (sbErr) {
    Logger.log('Supabase insert lead exception: ' + sbErr.toString());
    supaResult = { success: false, error: sbErr.toString() };
  }

  // Dispara Meta CAPI Lead/AgendarConsulta (custom event — site é saúde, Lead nativo bloqueado)
  let capiResult = null;
  try {
    capiResult = enviarLeadCapi_({
      leadId: leadId,
      eventId: 'lead_' + (leadId || Date.now()),
      email: email,
      telefone: telefone,
      nome: nome,
      fbp: fbp,
      fbc: fbc,
      fbclid: fbclid,
      lp_url: lp_url,
      especialidade: especialidade
    });
  } catch (capiErr) {
    capiResult = { error: capiErr.toString() };
  }

  return { success: !!leadId, lead_id: leadId, supabase: supaResult, capi: capiResult };
}

/**
 * Envia evento "AgendarConsulta" (trackCustom) pra Meta CAPI.
 * Mesma estrutura do dispatch da venda, mas pra lead.
 */
function enviarLeadCapi_(ctx) {
  const token = getMetaCAPIToken();
  if (!token) return { skipped: true, reason: 'no_token' };

  const user_data = {};
  if (ctx.email) user_data.em = [sha256Hex(normalizeEmail(ctx.email))];
  if (ctx.telefone) user_data.ph = [sha256Hex(normalizePhone(ctx.telefone))];
  if (ctx.fbp) user_data.fbp = ctx.fbp;
  if (ctx.fbc) user_data.fbc = ctx.fbc;
  if (ctx.nome) {
    const split = splitFullName(ctx.nome);
    if (split.fn) user_data.fn = [sha256Hex(split.fn.toLowerCase())];
    if (split.ln) user_data.ln = [sha256Hex(split.ln.toLowerCase())];
  }

  if (!user_data.em && !user_data.ph && !user_data.fbp && !user_data.fbc) {
    return { skipped: true, reason: 'no_pii' };
  }

  let sourceUrl = ctx.lp_url || 'https://drdanilomatsunaga.com.br/';
  if (ctx.fbclid && sourceUrl.indexOf('fbclid=') < 0) {
    sourceUrl += (sourceUrl.indexOf('?') >= 0 ? '&' : '?') + 'fbclid=' + encodeURIComponent(ctx.fbclid);
  }

  const payload = {
    data: [{
      event_name: 'AgendarConsulta',
      event_time: Math.floor(Date.now() / 1000),
      event_id: ctx.eventId,
      action_source: 'website',
      event_source_url: sourceUrl,
      user_data: user_data,
      custom_data: {
        content_name: ctx.especialidade || 'Consulta médica',
        content_category: 'Saúde'
      }
    }]
  };
  if (META_CAPI_TEST_CODE) payload.test_event_code = META_CAPI_TEST_CODE;

  const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID +
    '/events?access_token=' + encodeURIComponent(token);

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  Logger.log('Lead CAPI response: ' + code + ' ' + body.slice(0, 200));

  // Marca o lead como capi_sent
  if (ctx.leadId && code >= 200 && code < 300) {
    try {
      const cfg = getSupabaseConfig_();
      UrlFetchApp.fetch(cfg.url + '/rest/v1/leads_consultas?id=eq.' + ctx.leadId, {
        method: 'patch',
        contentType: 'application/json',
        headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key },
        payload: JSON.stringify({
          capi_sent: true,
          capi_sent_at: new Date().toISOString(),
          capi_event_id: ctx.eventId
        }),
        muteHttpExceptions: true
      });
    } catch (_e) {}
  }

  return { success: code >= 200 && code < 300, status: code, body: body.slice(0, 200) };
}

// ============================================================
// V8.12 — CUSTOM AUDIENCE META AUTOMATIZADA
// Cria audience "Compradores Kiwify" e sincroniza emails+telefones
// de toda venda paga. Lookalike Audience é criada manualmente em cima
// dela no Business Manager (1x).
// ============================================================

const CUSTOM_AUDIENCE_NAME = 'Compradores Kiwify - Dr Danilo';
const CUSTOM_AUDIENCE_DESCRIPTION = 'Compradores reais do Destrave 14D (sincronizado via Apps Script)';

/**
 * Cria a Custom Audience na Meta (se ainda não existir) e retorna o ID.
 * Roda 1x manualmente do editor.
 */
function criarCustomAudienceCompradores() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('MT_TOKEN');
  const acct = props.getProperty('MT_ACCT');
  if (!token || !acct) return { error: 'missing_credentials' };

  // Verifica se já existe (busca pelo nome)
  const listUrl = 'https://graph.facebook.com/' + META_INSIGHTS_API_VERSION + '/' + acct +
    '/customaudiences?fields=id,name,approximate_count_lower_bound&limit=200&access_token=' + encodeURIComponent(token);
  const listResp = UrlFetchApp.fetch(listUrl, { muteHttpExceptions: true });
  if (listResp.getResponseCode() >= 200 && listResp.getResponseCode() < 300) {
    const list = JSON.parse(listResp.getContentText());
    const existing = (list.data || []).find(function (a) { return a.name === CUSTOM_AUDIENCE_NAME; });
    if (existing) {
      Logger.log('Audience já existe: ' + existing.id);
      props.setProperty('MT_CA_COMPRADORES', existing.id);
      return { success: true, audience_id: existing.id, existed: true };
    }
  }

  // Cria nova
  const createUrl = 'https://graph.facebook.com/' + META_INSIGHTS_API_VERSION + '/' + acct +
    '/customaudiences';
  const payload = {
    name: CUSTOM_AUDIENCE_NAME,
    description: CUSTOM_AUDIENCE_DESCRIPTION,
    subtype: 'CUSTOM',
    customer_file_source: 'USER_PROVIDED_ONLY',  // dado de cliente fornecido por nós
    access_token: token
  };
  const resp = UrlFetchApp.fetch(createUrl, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  Logger.log('Create audience: ' + code + ' ' + body);
  if (code >= 200 && code < 300) {
    const parsed = JSON.parse(body);
    props.setProperty('MT_CA_COMPRADORES', parsed.id);
    return { success: true, audience_id: parsed.id, created: true };
  }
  return { success: false, status: code, body: body };
}

/**
 * Sincroniza emails+telefones de TODAS as vendas pagas com a Custom Audience.
 * Idempotente (Meta deduplica). Hashes SHA-256 LOWERCASE conforme exigido.
 *
 * Pode rodar manualmente ou via trigger diário.
 */
function sincronizarCompradoresParaAudience() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('MT_TOKEN');
  let audienceId = props.getProperty('MT_CA_COMPRADORES');

  if (!audienceId) {
    Logger.log('MT_CA_COMPRADORES ausente — criando audience');
    const r = criarCustomAudienceCompradores();
    if (!r.success) return r;
    audienceId = r.audience_id;
  }

  // Busca vendas pagas no Supabase
  const cfg = getSupabaseConfig_();
  const fetchUrl = cfg.url + '/rest/v1/vendas?select=cliente_email,cliente_phone,cliente_cpf,cliente_nome&status=in.(paid,approved)&order_id=not.like.TEST*&limit=1000';
  const fetchResp = UrlFetchApp.fetch(fetchUrl, {
    headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  });
  if (fetchResp.getResponseCode() < 200 || fetchResp.getResponseCode() >= 300) {
    Logger.log('Fetch vendas falhou: ' + fetchResp.getResponseCode());
    return { error: 'fetch_vendas_failed' };
  }
  const vendas = JSON.parse(fetchResp.getContentText());
  Logger.log('Vendas pagas encontradas: ' + vendas.length);

  if (vendas.length === 0) return { success: true, count: 0 };

  // Monta payload Meta — schema EMAIL,PHONE,FN,LN (cada item hashed individualmente)
  const data = [];
  vendas.forEach(function (v) {
    const email = (v.cliente_email || '').trim().toLowerCase();
    const phone = (v.cliente_phone || '').replace(/\D/g, '');
    const split = v.cliente_nome ? splitFullName(v.cliente_nome) : { fn: '', ln: '' };
    const fn = (split.fn || '').toLowerCase().trim();
    const ln = (split.ln || '').toLowerCase().trim();
    // Schema posicional: [EMAIL, PHONE, FN, LN]
    data.push([
      email ? sha256Hex(email) : '',
      phone ? sha256Hex(phone) : '',
      fn ? sha256Hex(fn) : '',
      ln ? sha256Hex(ln) : ''
    ]);
  });

  // Manda em lotes de 500 (limite Meta é 10k mas 500 é seguro)
  const url = 'https://graph.facebook.com/' + META_INSIGHTS_API_VERSION + '/' + audienceId + '/users';
  let totalEnviados = 0;
  let lotes = 0;
  for (let i = 0; i < data.length; i += 500) {
    const lote = data.slice(i, i + 500);
    const payloadObj = {
      schema: ['EMAIL', 'PHONE', 'FN', 'LN'],
      data: lote
    };
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: {
        payload: JSON.stringify(payloadObj),
        access_token: token
      },
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    lotes++;
    if (code >= 200 && code < 300) {
      const parsed = JSON.parse(body);
      totalEnviados += (parsed.num_received || lote.length);
    } else {
      Logger.log('Lote ' + i + ' falhou: ' + code + ' ' + body.slice(0, 300));
    }
  }

  Logger.log('Sincronização Custom Audience: ' + totalEnviados + ' contatos em ' + lotes + ' lotes');
  return { success: true, audience_id: audienceId, count: totalEnviados, lotes: lotes };
}

/**
 * Cria trigger DIÁRIO pra rodar sincronização (1x por dia, 6am).
 * Por que diário (e não a cada venda): Meta processa em batch e demora
 * 30min-1h pra audience refletir. Mais eficiente mandar uma vez por dia.
 */
function criarTriggerSincronizacaoAudience() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sincronizarCompradoresParaAudience'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('sincronizarCompradoresParaAudience')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();

  Logger.log('Trigger diário (6am) criado pra sincronizarCompradoresParaAudience');
  return { success: true };
}

/**
 * Teste rápido — usa só 2 vendas pra validar o fluxo sem mandar batch grande.
 */
function testarCustomAudience() {
  const r1 = criarCustomAudienceCompradores();
  Logger.log('Create audience: ' + JSON.stringify(r1));
  if (!r1.success) return r1;

  const r2 = sincronizarCompradoresParaAudience();
  Logger.log('Sync result: ' + JSON.stringify(r2));
  return { create: r1, sync: r2 };
}

/**
 * Teste rápido — simula um lead de consulta entrando.
 */
function testarLeadConsulta() {
  const r = handleLeadConsulta_(
    {
      token: 'drdanilo_kiwify_2026_x9p7q3',
      nome: 'Teste Lead',
      email: 'teste.lead.' + Date.now() + '@example.com',
      telefone: '11999999999',
      especialidade: 'Emagrecimento',
      utm_source: 'TEST',
      utm_campaign: 'TEST_LEAD_FLOW',
      lp_url: 'https://drdanilomatsunaga.com.br/'
    },
    null
  );
  Logger.log('Resultado teste lead: ' + JSON.stringify(r));
  return r;
}

/**
 * Testa conexão Supabase — insere venda dummy e remove em seguida.
 * Roda manualmente do editor pra validar SB_URL e SB_KEY.
 */
function testarConexaoSupabase() {
  const orderId = 'TEST_' + Date.now();
  const r1 = enviarVendaParaSupabase_({
    order_id: orderId,
    created_at: new Date().toISOString(),
    valor: 1,
    status: 'paid',
    utm_source: 'TEST',
    cliente_nome: 'Teste Conexao',
    cliente_email: 'teste@example.com'
  });
  Logger.log('Insert teste: ' + JSON.stringify(r1));

  // Cleanup
  const cfg = getSupabaseConfig_();
  const r2 = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/vendas?order_id=eq.' + encodeURIComponent(orderId),
    {
      method: 'delete',
      headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key },
      muteHttpExceptions: true
    }
  );
  Logger.log('Cleanup teste: ' + r2.getResponseCode());
  return r1;
}

/**
 * Health check — GET na URL do webhook retorna JSON com status.
 * Também serve endpoint admin protegido por secret pra cleanup de testes.
 */
function doGet(e) {
  const params = e.parameter || {};
  const ADMIN_SECRET = 'drdanilo_kiwify_2026_x9p7q3';

  // V8.11: Endpoint público pra lead de consulta vindo de form WordPress/Elementor
  // ?action=lead_consulta&token=X&nome=...&email=...&telefone=...&utm_source=...
  if (params.action === 'lead_consulta') {
    const r = handleLeadConsulta_(params, e);
    return ContentService.createTextOutput(JSON.stringify(r))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin: cleanup de linhas de teste (autenticado)
  if (params.action === 'cleanup_tests' && params.secret === ADMIN_SECRET) {
    const dry = params.dry === 'true';
    const v = limparLinhasTeste_(dry);
    const w = limparWebhookDebugTeste_(dry);
    return ContentService.createTextOutput(JSON.stringify({
      action: 'cleanup_tests',
      dryRun: dry,
      vendas: v,
      webhookDebug: w
    }, null, 2)).setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin: auditoria de todas as abas e triggers
  if (params.action === 'audit_sheets' && params.secret === ADMIN_SECRET) {
    return ContentService.createTextOutput(JSON.stringify(
      auditarPlanilha_(), null, 2
    )).setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin: deletar uma aba específica (com confirmação via dry)
  if (params.action === 'delete_sheet' && params.secret === ADMIN_SECRET && params.name) {
    const dry = params.dry === 'true';
    return ContentService.createTextOutput(JSON.stringify(
      deletarAba_(params.name, dry), null, 2
    )).setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoints temporários: recriar trigger Kommo + forçar sync agora
  if (params.action === 'recreate_kommo_trigger' && params.secret === ADMIN_SECRET) {
    return ContentService.createTextOutput(JSON.stringify(criarTriggerKommoSync(), null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'sync_kommo_now' && params.secret === ADMIN_SECRET) {
    const r = syncKommoIncremental();
    return ContentService.createTextOutput(JSON.stringify(r, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (params.action === 'leads_hoje' && params.secret === ADMIN_SECRET) {
    const cfg = getSupabaseConfig_();
    const hoje = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');
    // Fetch leads + pipelines for name lookup
    const leadsUrl = cfg.url + '/rest/v1/kommo_leads?select=lead_id,name,pipeline_id,stage_id,price,utm_source,utm_campaign,utm_content,tags,created_at,updated_at,cidade,is_deleted'
      + '&updated_at=gte.' + hoje + 'T00:00:00&is_deleted=eq.false&order=updated_at.desc&limit=200';
    const pipelinesUrl = cfg.url + '/rest/v1/kommo_pipelines?select=pipeline_id,name&limit=50';
    const stagesUrl = cfg.url + '/rest/v1/kommo_stages?select=pipeline_id,stage_id,name&limit=200';
    const opts = { headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key }, muteHttpExceptions: true };
    const leadsResp   = UrlFetchApp.fetch(leadsUrl,   opts);
    const pipResp     = UrlFetchApp.fetch(pipelinesUrl, opts);
    const stagesResp  = UrlFetchApp.fetch(stagesUrl,  opts);
    const leads   = JSON.parse(leadsResp.getContentText());
    const pips    = JSON.parse(pipResp.getContentText());
    const stages  = JSON.parse(stagesResp.getContentText());
    const pipMap   = {}; (Array.isArray(pips)   ? pips   : []).forEach(function(p) { pipMap[p.pipeline_id]  = p.name; });
    const stageMap = {}; (Array.isArray(stages) ? stages : []).forEach(function(s) { stageMap[s.stage_id]   = s.name; });
    const enriched = (Array.isArray(leads) ? leads : []).map(function(l) {
      return Object.assign({}, l, {
        pipeline_name: pipMap[l.pipeline_id] || l.pipeline_id,
        stage_name: stageMap[l.stage_id] || l.stage_id
      });
    });
    return ContentService.createTextOutput(JSON.stringify(enriched, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin: deletar todos os triggers (com dry)
  if (params.action === 'delete_triggers' && params.secret === ADMIN_SECRET) {
    const dry = params.dry === 'true';
    return ContentService.createTextOutput(JSON.stringify(
      deletarTriggers_(dry), null, 2
    )).setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin: inspecionar venda específica (search por email, orderId, ou nome parcial)
  if (params.action === 'inspect_sale' && params.secret === ADMIN_SECRET) {
    return ContentService.createTextOutput(JSON.stringify(
      inspecionarVenda_(params.q || ''), null, 2
    )).setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin: re-dispara CAPI Purchase pra um order_id que existe em Webhook Debug
  // (evento usa o MESMO event_id, então Meta dedup naturalmente — não duplica)
  if (params.action === 'resend_purchase' && params.secret === ADMIN_SECRET) {
    return ContentService.createTextOutput(JSON.stringify(
      reenviarPurchase_(params.order_id || ''), null, 2
    )).setMimeType(ContentService.MimeType.JSON);
  }

  // Endpoint admin temporário: busca leads criados hoje no Kommo com campos UTM
  if (params.action === 'query_leads_hoje' && params.secret === ADMIN_SECRET) {
    return ContentService.createTextOutput(JSON.stringify(
      queryLeadsHoje_(), null, 2
    )).setMimeType(ContentService.MimeType.JSON);
  }

  // V8.7: Endpoint público (sem secret) pra receber ViewContent do navegador
  // e reenviar via CAPI com MESMO event_id → dedup automática com Pixel browser.
  // Resolve warning 3 do Events Manager (CAPI tem ~0 ViewContent vs 1.688 do Pixel).
  // Chamado pela tag GTM "Meta Pixel - ViewContent LP Emagrecimento" via fetch.
  if (params.action === 'viewcontent') {
    try {
      const r = handleViewContentEvent_(params, e);
      return ContentService.createTextOutput(JSON.stringify(r))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({error: err.toString()}))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lastRow = ss.getSheetByName('Vendas Kiwify')
    ? ss.getSheetByName('Vendas Kiwify').getLastRow() : -1;
  const debugLast = ss.getSheetByName('Webhook Debug')
    ? ss.getSheetByName('Webhook Debug').getLastRow() : -1;
  return ContentService.createTextOutput(JSON.stringify({
    status: 'alive',
    version: 'V8.16',
    pixelId: META_PIXEL_ID,
    eventSourceUrl: META_EVENT_SOURCE_URL,
    sheetVendasLastRow: lastRow,
    sheetDebugLastRow: debugLast,
    serverTime: new Date().toISOString()
  }, null, 2)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Heurística: identifica se uma linha de Vendas Kiwify é teste sintético.
 * Cobre os padrões usados nos testes V8.x (V8_DEBUG_TEST, V81_TESTE_*, V82_*),
 * emails de teste (@teste.com, @example.com, @d.com, debug@), e nomes claramente sintéticos.
 */
function ehLinhaTesteVendas_(row) {
  const utmCampaign = String(row[1] || '').toLowerCase();
  const produto = String(row[8] || '').toLowerCase();
  const nome = String(row[9] || '').toLowerCase();
  const email = String(row[10] || '').toLowerCase();
  const orderId = String(row[12] || '').toUpperCase();

  if (/^(TEST_|V8_|V81_|V82_|DEBUG_|PYTHON_|DEMO_|EXAMPLE_)/i.test(orderId)) return true;
  if (/@teste\.com|@example\.com|@exemplo\.com|@d\.com|@pyteste|debug@|^v8\.debug@|^rich\.|^a\.|^b\.|^c\.|^d\.\d/i.test(email)) return true;
  if (/v8_debug|v81_teste|v82_pur|v82_noemail|teste_python|teste_debug/i.test(utmCampaign)) return true;
  if (/^john doe$|cliente teste|cliente debug|cliente v8|cliente rico|cliente a$|cliente b$|cliente c$|cliente d$|^anonymous$|debug v8/i.test(nome)) return true;
  if (/example product|exemplo produto/i.test(produto)) return true;
  return false;
}

/**
 * Auditoria completa: lista todas as abas com metadata + triggers ativos.
 */
function auditarPlanilha_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const sheetsInfo = sheets.map(s => {
    const lastRow = s.getLastRow();
    const lastCol = s.getLastColumn();
    let headers = [];
    let sampleRows = [];
    try {
      if (lastRow > 0 && lastCol > 0) {
        // Pega até as 5 primeiras linhas + últimas 2 (limitado a 12 colunas)
        const cols = Math.min(lastCol, 12);
        const headerCount = Math.min(lastRow, 5);
        headers = s.getRange(1, 1, headerCount, cols).getValues();
        if (lastRow > 7) {
          sampleRows = s.getRange(Math.max(2, lastRow - 1), 1, 2, cols).getValues();
        }
      }
    } catch (e) {}
    // Formulas presentes?
    let hasFormulas = false;
    let formulaSamples = [];
    try {
      if (lastRow > 0 && lastCol > 0) {
        const cols = Math.min(lastCol, 12);
        const rows = Math.min(lastRow, 30);
        const fs = s.getRange(1, 1, rows, cols).getFormulas();
        for (let r = 0; r < fs.length; r++) {
          for (let c = 0; c < fs[r].length; c++) {
            if (fs[r][c]) {
              hasFormulas = true;
              if (formulaSamples.length < 4) formulaSamples.push({
                cell: String.fromCharCode(65 + c) + (r + 1),
                formula: fs[r][c].slice(0, 120)
              });
            }
          }
        }
      }
    } catch (e) {}
    return {
      name: s.getName(),
      sheetId: s.getSheetId(),
      index: s.getIndex(),
      hidden: s.isSheetHidden(),
      rowCount: s.getMaxRows(),
      colCount: s.getMaxColumns(),
      lastRow,
      lastCol,
      hasFormulas,
      formulaSamples,
      headersFirst5Rows: headers.map(r => r.map(c => {
        if (c instanceof Date) return c.toISOString();
        return String(c).slice(0, 60);
      })),
      lastDataRows: sampleRows.map(r => r.map(c => {
        if (c instanceof Date) return c.toISOString();
        return String(c).slice(0, 60);
      }))
    };
  });

  const triggers = ScriptApp.getProjectTriggers().map(t => ({
    handler: t.getHandlerFunction(),
    eventType: String(t.getEventType()),
    triggerSource: String(t.getTriggerSource()),
    uniqueId: t.getUniqueId()
  }));

  return {
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    sheetCount: sheets.length,
    sheets: sheetsInfo,
    triggerCount: triggers.length,
    triggers
  };
}

function deletarAba_(name, dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName(name);
  if (!aba) return { error: 'sheet not found', name };
  const meta = {
    name: aba.getName(),
    lastRow: aba.getLastRow(),
    lastCol: aba.getLastColumn(),
    rowCount: aba.getMaxRows()
  };
  if (dryRun) return { ok: true, dryRun: true, would_delete: meta };
  ss.deleteSheet(aba);
  return { ok: true, deleted: meta };
}

/**
 * Inspeciona uma venda específica em ambas as abas (Vendas Kiwify + Webhook Debug)
 * por email, orderId, nome ou substring.
 */
function inspecionarVenda_(query) {
  if (!query) return { error: 'query vazia' };
  const q = String(query).toLowerCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = { query, vendas: [], webhookDebug: [], analysis: {} };

  // 1. Vendas Kiwify
  const vendasAba = ss.getSheetByName('Vendas Kiwify');
  if (vendasAba) {
    const lr = vendasAba.getLastRow();
    if (lr > 1) {
      const data = vendasAba.getRange(1, 1, lr, 13).getValues();
      const headers = data[0];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row.some(cell => String(cell).toLowerCase().includes(q))) {
          const obj = {};
          headers.forEach((h, idx) => {
            obj[String(h) || ('col' + idx)] = row[idx] instanceof Date ? row[idx].toISOString() : String(row[idx]);
          });
          obj._sheetRow = i + 1;
          result.vendas.push(obj);
        }
      }
    }
  }

  // 2. Webhook Debug
  const debugAba = ss.getSheetByName('Webhook Debug');
  if (debugAba) {
    const lr = debugAba.getLastRow();
    if (lr > 1) {
      const data = debugAba.getRange(1, 1, lr, 6).getValues();
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row.some(cell => String(cell).toLowerCase().includes(q))) {
          result.webhookDebug.push({
            sheetRow: i + 1,
            timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
            status: String(row[1]),
            orderId: String(row[2]),
            fbpFbcDetected: String(row[3]),
            urlParams: String(row[4]).slice(0, 300),
            rawJson: String(row[5]).slice(0, 8000)
          });
        }
      }
    }
  }

  // 3. Análise rápida do raw JSON pra extrair matching keys
  if (result.webhookDebug.length > 0) {
    const paid = result.webhookDebug.find(r => /paid|approved|aprovad/i.test(r.status));
    const interesting = paid || result.webhookDebug[0];
    try {
      const parsed = JSON.parse(interesting.rawJson);
      const order = parsed.Order || parsed.order || parsed;
      const tracking = order.tracking || parsed.tracking || {};
      const customer = parsed.Customer || parsed.customer || {};
      result.analysis = {
        usingPayload: { status: interesting.status, orderId: interesting.orderId },
        utmTerm: tracking.utm_term || null,
        utmTermParsed: parseFbpFbcFromUtmTerm(tracking.utm_term || ''),
        fbpDireto: tracking._fbp || tracking.fbp || null,
        fbcDireto: tracking._fbc || tracking.fbc || null,
        ip: order.ip || customer.ip || null,
        utm_source: tracking.utm_source || null,
        utm_campaign: tracking.utm_campaign || null,
        utm_medium: tracking.utm_medium || null,
        utm_content: tracking.utm_content || null,
        email: customer.email || null,
        cpf: customer.CPF || customer.cpf || null
      };
    } catch (e) {
      result.analysis = { error: 'parse failed: ' + e.toString() };
    }
  }

  return result;
}

/**
 * Re-dispara Purchase pro Meta CAPI usando o payload original do Webhook Debug.
 * Útil pra confirmar que o CAPI está respondendo OK depois do fato.
 * Como event_id é determinístico (purchase_<orderId>), Meta dedup automaticamente
 * (não conta como evento duplicado).
 */
function reenviarPurchase_(orderId) {
  if (!orderId) return { error: 'order_id obrigatório' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const debugAba = ss.getSheetByName('Webhook Debug');
  if (!debugAba) return { error: 'aba Webhook Debug não existe' };

  // Procura na Webhook Debug uma linha com esse order_id e status paid/approved
  const lr = debugAba.getLastRow();
  if (lr < 2) return { error: 'sem dados em Webhook Debug' };
  const data = debugAba.getRange(1, 1, lr, 6).getValues();

  let payloadRow = null;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = String(row[1] || '').toLowerCase();
    const oid = String(row[2] || '');
    if (oid === orderId && /paid|approved|aprovad/.test(status)) {
      payloadRow = row;
      break;
    }
  }
  // Fallback: aceita qualquer status (apenas a primeira ocorrência)
  if (!payloadRow) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][2] || '') === orderId) {
        payloadRow = data[i];
        break;
      }
    }
  }
  if (!payloadRow) return { error: 'order_id não encontrado em Webhook Debug', orderId };

  let parsed;
  try { parsed = JSON.parse(payloadRow[5]); }
  catch (e) { return { error: 'falha ao parsear raw JSON: ' + e.toString() }; }

  const order = parsed.Order || parsed.order || parsed;
  const customer = parsed.Customer || parsed.customer || order.customer || {};
  const tracking = order.tracking || parsed.tracking || parsed.TrackingParameters || {};
  // Valor: tenta charge_amount em commissions ou produto
  let valor = 0;
  if (parsed.Commissions && parsed.Commissions.charge_amount) {
    valor = Number(parsed.Commissions.charge_amount) / 100;
  } else if (order.subtotal_amount) {
    valor = Number(order.subtotal_amount);
  }
  if (!valor) valor = 97; // fallback

  const ctx = { data: parsed, order, customer, tracking, valor, params: {} };
  const result = sendPurchaseToMetaCAPI(ctx);

  // Inclui no resultado um diagnóstico do user_data construído (sem expor PII)
  const userData = buildUserData(customer, tracking, parsed, {}, order);
  const userDataKeys = Object.keys(userData);

  return {
    orderId,
    statusFromPayload: String(payloadRow[1]),
    capiResponse: result,
    userDataFieldsSent: userDataKeys,
    matchScore: countMatchedFields(userData),
    fbpFromPayload: !!(userData.fbp),
    fbcFromPayload: !!(userData.fbc),
    ipFromPayload: !!(userData.client_ip_address),
    valor: valor
  };
}

function deletarTriggers_(dryRun) {
  const triggers = ScriptApp.getProjectTriggers();
  const meta = triggers.map(t => ({
    handler: t.getHandlerFunction(),
    eventType: String(t.getEventType()),
    uniqueId: t.getUniqueId()
  }));
  if (dryRun) return { ok: true, dryRun: true, would_delete: meta };
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  return { ok: true, deleted_count: meta.length, deleted: meta };
}

function limparLinhasTeste_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName('Vendas Kiwify');
  if (!aba) return { error: 'no Vendas Kiwify tab' };
  const lastRow = aba.getLastRow();
  if (lastRow < 2) return { ok: true, scanned: 0, candidates: [], removed: 0 };

  // Pula header(s). Detecta dinamicamente: linha de header é aquela onde
  // a coluna A NÃO é uma data válida (é texto tipo "Data" ou similar).
  let startRow = 2;
  for (let r = 1; r <= Math.min(5, lastRow); r++) {
    const v = aba.getRange(r, 1).getValue();
    if (v instanceof Date) { startRow = r; break; }
  }
  const numRows = lastRow - startRow + 1;
  if (numRows < 1) return { ok: true, scanned: 0, candidates: [], removed: 0 };

  const range = aba.getRange(startRow, 1, numRows, 13);
  const values = range.getValues();

  const candidates = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (ehLinhaTesteVendas_(row)) {
      candidates.push({
        sheetRow: startRow + i,
        data: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
        utmCampaign: row[1],
        nome: row[9],
        email: row[10],
        orderId: row[12]
      });
    }
  }

  if (dryRun) return { ok: true, scanned: values.length, candidates, removed: 0 };

  // Remove de baixo pra cima (preserva índices)
  candidates.sort((a, b) => b.sheetRow - a.sheetRow);
  candidates.forEach(c => aba.deleteRow(c.sheetRow));
  return { ok: true, scanned: values.length, candidates, removed: candidates.length };
}

function limparWebhookDebugTeste_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName('Webhook Debug');
  if (!aba) return { error: 'no Webhook Debug tab' };
  const lastRow = aba.getLastRow();
  if (lastRow < 2) return { ok: true, scanned: 0, candidates: [], removed: 0 };

  const range = aba.getRange(2, 1, lastRow - 1, 6);
  const values = range.getValues();

  const candidates = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const orderId = String(row[2] || '').toUpperCase();
    const rawJson = String(row[5] || '');
    const isTest =
      /^(TEST_|V8_|V81_|V82_|DEBUG_|PYTHON_|DEMO_|EXAMPLE_)/i.test(orderId)
      || /@teste\.com|@example\.com|@exemplo\.com|@d\.com|debug@|v8\.debug@|TESTE_PYTHON|TESTE_FBP|TESTE_FBC|cenarioA|cenarioB|cenarioC|cenarioD|TESTE_FBCLID|PAYLOAD_FBP|PAYLOAD_FBC/i.test(rawJson);
    if (isTest) {
      candidates.push({
        sheetRow: i + 2,
        timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
        status: row[1],
        orderId: row[2]
      });
    }
  }

  if (dryRun) return { ok: true, scanned: values.length, candidates, removed: 0 };

  candidates.sort((a, b) => b.sheetRow - a.sheetRow);
  candidates.forEach(c => aba.deleteRow(c.sheetRow));
  return { ok: true, scanned: values.length, candidates, removed: candidates.length };
}

function doPost(e) {
  try {
    const params = e.parameter || {};
    const rawContents = (e.postData && e.postData.contents) ? e.postData.contents : '';

    // V8.11: Se action=lead_consulta, roteia pro handler de leads (Elementor manda POST)
    if (params.action === 'lead_consulta') {
      const r = handleLeadConsulta_(params, e);
      return ContentService.createTextOutput(JSON.stringify(r))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // V8.16: Se action=kommo_webhook, roteia pro handler Kommo
    if (params.action === 'kommo_webhook') {
      const r = handleKommoWebhook_(params, e);
      return ContentService.createTextOutput(JSON.stringify(r))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const tokenRecebido = params.token || '';
    if (KIWIFY_WEBHOOK_TOKEN && tokenRecebido !== KIWIFY_WEBHOOK_TOKEN) {
      try { logarPayloadDebug(rawContents, params, { _tokenInvalido: true }); } catch (_e) {}
      return ContentService.createTextOutput(JSON.stringify({error: 'token inválido'}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const data = JSON.parse(rawContents);

    // DEBUG V8: loga payload cru ANTES do filtro de status (captura TODOS os hits da Kiwify)
    try { logarPayloadDebug(rawContents, params, data); } catch (_e) {}

    const order = data.Order || data.order || data;
    const customer = data.Customer || data.customer || order.customer || {};
    const tracking = order.tracking || data.tracking || data.TrackingParameters || {};

    const status = order.order_status || data.webhook_event_type || data.event_name || '';
    const statusNorm = String(status).toLowerCase();
    const ehVendaPaga = /paid|approved|aprovad/.test(statusNorm);
    // V8.2: status que indicam que o user CHEGOU no checkout Kiwify (mas ainda não pagou)
    const ehCheckoutAtingido = /pix_created|pix_pending|pending|waiting_payment|created|generated/.test(statusNorm);

    // V8.2: dispara InitiateCheckout server-side quando user atinge checkout (mesmo sem pagar)
    // Isso enriquece o sinal pro algoritmo do Meta — IC server-side é mais confiável que browser.
    if (!ehVendaPaga && ehCheckoutAtingido) {
      let icResult = null;
      try {
        icResult = sendInitiateCheckoutToMetaCAPI({ data, order, customer, tracking, params });
      } catch (icErr) {
        Logger.log('Erro IC CAPI: ' + icErr.toString());
        icResult = { error: icErr.toString() };
      }
      return ContentService.createTextOutput(JSON.stringify({
        success: true, ignored: 'status_nao_paga', status, capi_ic: icResult
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Outros status pré-pagos sem CAPI (refund/chargeback futuro pode entrar aqui)
    if (!ehVendaPaga) {
      return ContentService.createTextOutput(JSON.stringify({success: true, ignored: 'status_nao_paga', status}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Extract order_id pra dedup
    const orderId = String(
      order.id || order.order_id || data.order_id || data.id || ''
    );

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let aba = ss.getSheetByName('Vendas Kiwify');
    if (!aba) aba = ss.insertSheet('Vendas Kiwify');

    // DEDUP: verifica se order_id já existe na coluna M (13)
    if (orderId) {
      const lastRow = aba.getLastRow();
      if (lastRow > 1) {
        const orderIdCol = aba.getRange(2, 13, lastRow - 1, 1).getValues();
        const exists = orderIdCol.some(row => String(row[0]) === orderId);
        if (exists) {
          return ContentService.createTextOutput(JSON.stringify({success: true, ignored: 'duplicate_order_id', orderId}))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    const dataVenda = order.created_at || order.approved_date || new Date();
    // Extrai valor com múltiplos fallbacks (Kiwify varia o nome do campo)
    // V8.6: priorizar Commissions.charge_amount / product_base_price (campos REAIS
    // confirmados nos webhooks Kiwify de produção). Antes caía no fallback fixo R$97
    // → Meta marcava todos os Purchase com mesmo value e disparava warning de placeholder.
    function extrairValor() {
      // Tenta primeiro o valor BRUTO/CHEIO do produto (sem desconto de cupom)
      // NOTA: product_base_price vem ANTES de charge_amount porque charge_amount
      // pode ser o split do produtor após coprodutor (ex: 2127 = R$21,27, não R$97)
      const cheioCandidates = [
        order.Commissions?.product_base_price,   // preço real do produto em centavos
        order.Commissions?.charge_amount,        // fallback: pode ser split do produtor
        data.Commissions?.product_base_price,
        data.Commissions?.charge_amount,
        order.subtotal_amount,
        order.product_price,
        order.Product?.product_price,
        order.Product?.price,
        data.product_price,
        data.Product?.product_price
      ];
      for (const c of cheioCandidates) {
        const num = Number(c);
        if (num && num > 0) {
          return num > 1000 ? num / 100 : num;
        }
      }
      // Fallback: total pago (já com desconto se for o caso)
      const pagoCandidates = [
        order.total_amount,
        order.net_value,
        order.charges?.[0]?.amount,
        order.charges?.[0]?.product_price,
        data.amount
      ];
      for (const c of pagoCandidates) {
        const num = Number(c);
        if (num && num > 0) {
          return num > 1000 ? num / 100 : num;
        }
      }
      // V8.7: NÃO usar mais fallback fixo R$ 97 — retorna null.
      // O fallback no CAPI fazia 35% dos Purchase chegarem com mesmo valor →
      // Meta classifica como "preço inválido" + "preços iguais" (warnings 1 e 2 do
      // Events Manager). Agora: se valor não veio do webhook, Purchase CAPI é
      // pulado (mas planilha grava R$ 97 pra controle interno via extrairValorPlanilha).
      return null;
    }
    const valorExtraido = extrairValor();
    const valor = valorExtraido === null ? 0 : Math.round(valorExtraido * 100) / 100;
    const valorRealReportado = valorExtraido !== null;
    Logger.log('Valor extraído: R$ ' + valor + ' (real reportado=' + valorRealReportado + ') | order keys: ' + Object.keys(order || {}).join(','));
    const nome = customer.full_name || customer.name || '';
    const email = customer.email || '';
    const produto = order.Product?.product_name || order.product_name || '';
    const utmSource = tracking.utm_source || params.utm_source || '';
    const utmMedium = tracking.utm_medium || params.utm_medium || '';
    const utmCampaign = tracking.utm_campaign || params.utm_campaign || '';
    const utmContent = tracking.utm_content || params.utm_content || '';

    // V8.7: planilha grava o valor (real ou 97 fallback pra controle interno)
    const valorPlanilha = valorRealReportado ? valor : 97;

    aba.appendRow([
      new Date(dataVenda),
      utmCampaign,
      utmMedium,
      utmContent,
      valorPlanilha,
      '',
      '',
      utmSource,
      produto,
      nome,
      email,
      status,
      orderId  // coluna M = order_id pra dedup
    ]);

    // V8.8: Espelha a venda no Supabase pra alimentar o dashboard Lovable.
    // Roda em paralelo à planilha (continua sendo fonte de verdade financeira).
    // Falha aqui NÃO bloqueia o resto do fluxo — webhook ainda responde 200.
    const fbFbc = parseFbpFbcFromUtmTerm(tracking.utm_term || params.utm_term || '');
    const vendaSupabasePayload = {
      order_id: orderId,
      created_at: new Date(dataVenda).toISOString(),
      valor: valorPlanilha,
      moeda: 'BRL',
      utm_source: utmSource,
      utm_campaign: utmCampaign,
      utm_medium: utmMedium,
      utm_content: utmContent,            // = ad.id Meta — chave do JOIN
      utm_term: tracking.utm_term || params.utm_term || null,
      cliente_nome: nome || null,
      cliente_email: email || null,
      cliente_cpf: (customer.cpf || customer.CPF || '').replace(/\D/g, '') || null,
      cliente_phone: customer.mobile || customer.phone || null,
      cliente_ip: (e && e.parameter && e.parameter.ip) || null,
      produto_id: String(order.product_id || order.Product?.id || ''),
      produto_nome: produto || null,
      status: ehVendaPaga ? 'paid' : status,
      payment_method: order.payment_method || order.Payment?.method || null,
      fbp: fbFbc.fbp || null,
      fbc: fbFbc.fbc || null,
      raw_webhook: data
    };
    try {
      enviarVendaParaSupabase_(vendaSupabasePayload);
    } catch (sbErr) {
      Logger.log('Supabase insert vendas falhou: ' + sbErr.toString());
    }

    // V8.7: Só dispara Purchase no Meta CAPI quando valor é REAL do webhook.
    // Evita inflar Meta com R$ 97 placeholder que causa warning de preços iguais.
    let capiResult = null;
    if (valorRealReportado && valor > 0) {
      try {
        capiResult = sendPurchaseToMetaCAPI({ data, order, customer, tracking, valor, params });
      } catch (capiErr) {
        Logger.log('Erro ao enviar para Meta CAPI: ' + capiErr.toString());
        capiResult = { error: capiErr.toString() };
      }
    } else {
      Logger.log('V8.7: Purchase CAPI PULADO — valor não veio do webhook (placeholder). orderId=' + orderId);
      capiResult = { skipped: true, reason: 'no_real_value_from_webhook' };
    }

    // V8.8: Loga o evento CAPI Purchase no Supabase pra dashboard de saúde.
    try {
      const eventLogPayload = {
        event_id: 'purchase_' + orderId,
        event_name: 'Purchase',
        event_time: new Date(dataVenda).toISOString(),
        order_id: orderId,
        source: 'capi_apps_script',
        match_score: (capiResult && capiResult.matchScore) || null,
        has_fbp: !!fbFbc.fbp,
        has_fbc: !!fbFbc.fbc,
        has_email: !!email,
        has_phone: !!(customer.mobile || customer.phone),
        has_cpf: !!(customer.cpf || customer.CPF),
        meta_status_code: (capiResult && capiResult.status) || (capiResult && capiResult.success ? 200 : null),
        meta_response: capiResult || null,
        meta_events_received: (capiResult && capiResult.eventsReceived) || null,
        meta_fbtrace_id: (capiResult && capiResult.fbtraceId) || null
      };
      logarEventoCAPISupabase_(eventLogPayload);

      // Atualiza a venda com flag capi_sent + match_quality
      if (capiResult && capiResult.success) {
        enviarVendaParaSupabase_({
          order_id: orderId,
          capi_sent: true,
          capi_sent_at: new Date().toISOString(),
          capi_event_id: 'purchase_' + orderId,
          match_score: capiResult.matchScore || null,
          match_quality: capiResult.matchScore || null
        });
      }
    } catch (logErr) {
      Logger.log('Supabase events_capi falhou: ' + logErr.toString());
    }

    return ContentService.createTextOutput(JSON.stringify({success: true, capi: capiResult, orderId}))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// META CONVERSIONS API - Implementação
// ============================================================

/**
 * Calcula SHA-256 e retorna hex lowercase (formato exigido pela Meta).
 */
/**
 * V8.7 — Recebe ViewContent vindo da tag GTM (via fetch) e reenvia ao Meta CAPI
 * com o MESMO event_id que o Pixel browser usou → Meta dedup automaticamente.
 *
 * Params esperados (query string):
 *   - event_id: ID único gerado no browser (obrigatório pra dedup)
 *   - event_source_url: URL da LP onde rolou o pageview
 *   - fbp: cookie _fbp do navegador
 *   - fbc: cookie _fbc do navegador (se houver fbclid)
 *   - fbclid: param da URL (opcional, complementa)
 *   - content_name, content_ids, content_category: opcionais (do produto)
 *
 * Esse endpoint é PÚBLICO (sem secret) porque a tag GTM browser-side precisa
 * acessar. O abuso fica limitado porque eventos sem fbp/fbc são pouco úteis.
 */
function handleViewContentEvent_(params, e) {
  const eventId = String(params.event_id || '').trim();
  if (!eventId) return { success: false, reason: 'missing_event_id' };

  const token = getMetaCAPIToken();
  if (!token) return { success: false, reason: 'no_token' };

  const eventTime = Math.floor(Date.now() / 1000);
  const sourceUrl = String(params.event_source_url || META_EVENT_SOURCE_URL);

  const userData = {};
  if (params.fbp) userData.fbp = String(params.fbp);
  if (params.fbc) userData.fbc = String(params.fbc);

  // IP e User Agent: vem do header (Apps Script doGet não recebe header IP por padrão,
  // mas a tag GTM pode passar via param `ip` se conhecer — geralmente não conhece).
  // O Meta aceita ViewContent sem IP/UA — fbp+fbc é suficiente pra matching.

  const customData = {
    content_name: String(params.content_name || 'Destrave Metabólico 14D'),
    content_ids: [String(params.content_ids || 'destrave_14d')],
    content_type: 'product',
    content_category: String(params.content_category || 'Saúde e Bem-estar')
  };

  const payload = {
    data: [{
      event_name: 'ViewContent',
      event_time: eventTime,
      event_id: eventId,           // mesmo ID do Pixel browser → dedup
      action_source: 'website',
      event_source_url: sourceUrl,
      user_data: userData,
      custom_data: customData
    }]
  };
  if (META_CAPI_TEST_CODE) payload.test_event_code = META_CAPI_TEST_CODE;

  const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID +
              '/events?access_token=' + encodeURIComponent(token);

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  Logger.log('V8.7 ViewContent CAPI response: ' + code + ' eventId=' + eventId);

  if (code >= 200 && code < 300) {
    const parsed = JSON.parse(body);
    return { success: true, eventsReceived: parsed.events_received, eventId };
  }
  return { success: false, status: code, body: body.slice(0, 500), eventId };
}

function sha256Hex(str) {
  if (!str) return '';
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(str),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/**
 * Normaliza email conforme regras da Meta:
 * - lowercase, trim, sem espaços
 */
function normalizeEmail(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}

/**
 * Normaliza telefone conforme Meta:
 * - apenas dígitos, com código do país (55 BR) na frente
 * - sem 0 inicial, sem +
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  // Se já vem com 55 e tem 12-13 dígitos totais, mantém
  // Se vem só com DDD + número (10-11 dígitos), prepende 55
  if (digits.length >= 10 && digits.length <= 11) {
    digits = '55' + digits;
  }
  return digits;
}

/**
 * Normaliza CPF: apenas dígitos.
 */
function normalizeCPF(cpf) {
  if (!cpf) return '';
  return String(cpf).replace(/\D/g, '');
}

/**
 * Separa nome completo em primeiro e último (Meta aceita 'fn' e 'ln').
 */
function splitFullName(fullName) {
  const parts = String(fullName || '').trim().toLowerCase().split(/\s+/);
  if (parts.length === 0) return { fn: '', ln: '' };
  if (parts.length === 1) return { fn: parts[0], ln: '' };
  return { fn: parts[0], ln: parts.slice(1).join(' ') };
}

/**
 * Parser para utm_term que carrega fbp/fbc empacotados.
 * Formatos aceitos:
 *   fbp:VALOR|fbc:VALOR
 *   fbp=VALOR|fbc=VALOR
 *   fbp:VALOR;fbc:VALOR
 *   fbp=VALOR&fbc=VALOR
 * Retorna { fbp, fbc } com null quando não encontra.
 */
function parseFbpFbcFromUtmTerm(utmTerm) {
  const out = { fbp: null, fbc: null };
  if (!utmTerm) return out;
  const s = String(utmTerm);
  const match = (key) => {
    const re = new RegExp(key + '\\s*[:=]\\s*([^|;,&\\s]+)', 'i');
    const m = s.match(re);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
  };
  out.fbp = match('fbp');
  out.fbc = match('fbc');
  return out;
}

/**
 * Constrói o user_data para Meta CAPI.
 * Campos hashed: em (email), ph (phone), fn (first name), ln (last name), external_id (CPF).
 * Campos plain: fbp, fbc, client_ip_address, client_user_agent.
 *
 * V8.1 — busca fbp/fbc em múltiplas fontes (defesa em profundidade):
 *  1. tracking._fbp / tracking.fbp (custom params, se Kiwify refletir)
 *  2. params (URL query da chamada webhook)
 *  3. request root (data.fbp)
 *  4. utm_term parseado (formato "fbp:X|fbc:Y") — caminho B do diagnóstico
 *  5. order.tracking_parameters / order.utm_term em variantes camelCase
 */
function buildUserData(customer, tracking, request, params, order) {
  const email = normalizeEmail(customer.email);
  const phone = normalizePhone(customer.mobile || customer.phone || customer.cellphone);
  const cpf = normalizeCPF(customer.CPF || customer.cpf || customer.document);
  const { fn, ln } = splitFullName(customer.full_name || customer.name);

  const userData = {};
  if (email) userData.em = [sha256Hex(email)];
  if (phone) userData.ph = [sha256Hex(phone)];
  if (fn) userData.fn = [sha256Hex(fn)];
  if (ln) userData.ln = [sha256Hex(ln)];
  if (cpf) userData.external_id = [sha256Hex(cpf)];

  const t = tracking || {};
  const p = params || {};
  const o = order || {};
  const r = request || {};

  // 1-3: fontes diretas
  let fbp = t._fbp || t.fbp || p._fbp || p.fbp || r.fbp || r._fbp;
  let fbc = t._fbc || t.fbc || p._fbc || p.fbc || r.fbc || r._fbc;

  // 4: utm_term empacotado (caminho B)
  if (!fbp || !fbc) {
    const utmTerm = t.utm_term || p.utm_term || o.utm_term || (o.tracking && o.tracking.utm_term) || '';
    const parsed = parseFbpFbcFromUtmTerm(utmTerm);
    if (!fbp && parsed.fbp) fbp = parsed.fbp;
    if (!fbc && parsed.fbc) fbc = parsed.fbc;
  }

  if (fbp) userData.fbp = String(fbp);
  if (fbc) userData.fbc = String(fbc);

  // IP e User-Agent (Meta usa pra advanced matching) — Kiwify às vezes manda
  const ip = o.ip || o.client_ip || o.customer_ip
    || (o.payment && o.payment.ip)
    || (customer && (customer.ip || customer.client_ip))
    || r.ip || p.ip;
  const ua = o.user_agent || o.client_user_agent
    || (customer && customer.user_agent)
    || r.user_agent || p.user_agent;
  if (ip) userData.client_ip_address = String(ip);
  if (ua) userData.client_user_agent = String(ua);

  return userData;
}

/**
 * Conta campos PII enviados ao CAPI — usado pra estimar Match Quality.
 * Quanto mais campos, melhor o matching no Meta. ~5 campos = "Bom"; ~7 = "Excelente".
 */
function countMatchedFields(userData) {
  if (!userData) return 0;
  const keys = ['em','ph','fn','ln','external_id','fbp','fbc','client_ip_address','client_user_agent'];
  return keys.filter(k => userData[k]).length;
}

/**
 * V8.2 — Gate de qualidade: bloqueia envio CAPI se NÃO tem nenhum identificador
 * (email/phone/cpf). Sem PII, Meta rejeita ou ignora pra atribuição.
 * Retorna { ok: bool, reason }.
 */
function validateUserDataForCapi(userData) {
  if (!userData) return { ok: false, reason: 'no_user_data' };
  const hasPII = !!(userData.em || userData.ph || userData.external_id);
  if (!hasPII) return { ok: false, reason: 'no_pii' };
  return { ok: true };
}

/**
 * Envia Purchase para Meta CAPI.
 * Recebe: { data, order, customer, tracking, valor, params }
 */
function sendPurchaseToMetaCAPI(ctx) {
  const token = getMetaCAPIToken();
  if (!token) {
    Logger.log('META_CAPI_TOKEN não configurado — pulando envio.');
    return { skipped: true, reason: 'no_token' };
  }

  const order = ctx.order || {};
  const customer = ctx.customer || {};
  const tracking = ctx.tracking || {};
  const valor = Number(ctx.valor) || 0;

  const orderId = String(
    order.id || order.order_id || ctx.data.order_id || ctx.data.id || ('order_' + Date.now())
  );

  const dataVenda = order.created_at || order.approved_date || order.paid_at || new Date();
  const eventTime = Math.floor(new Date(dataVenda).getTime() / 1000);

  const userData = buildUserData(customer, tracking, ctx.data, ctx.params || {}, order);

  // V8.2: Gate de PII — sem nenhum identificador, não envia (evita evento órfão)
  const validation = validateUserDataForCapi(userData);
  if (!validation.ok) {
    Logger.log('Purchase CAPI gate bloqueou envio: ' + validation.reason);
    return { skipped: true, reason: validation.reason };
  }

  const matchScore = countMatchedFields(userData);
  Logger.log('Purchase user_data match score: ' + matchScore + '/9');

  const customData = {
    currency: 'BRL',
    value: valor,
    content_name: order.Product?.product_name || order.product_name || 'Destrave Metabólico 14D',
    content_ids: [String(order.product_id || order.Product?.id || 'destrave_14d')],
    content_type: 'product',
    content_category: 'Saúde e Bem-estar',  // V8.2: ajuda categorizacao Meta
    num_items: 1,
    order_id: orderId,
    predicted_ltv: Math.round(valor * 1.5 * 100) / 100  // V8.6: LTV estimado = 1.5x ticket (Destrave 14D leva a upsell mentoria)
  };

  // V8.2: event_source_url enriquecida com fbclid se disponível (melhora matching)
  let sourceUrl = META_EVENT_SOURCE_URL;
  const fbclid = (tracking && tracking.fbclid) || (ctx.params && ctx.params.fbclid);
  if (fbclid) sourceUrl += (sourceUrl.indexOf('?') >= 0 ? '&' : '?') + 'fbclid=' + encodeURIComponent(fbclid);

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: 'purchase_' + orderId,
      action_source: 'website',
      event_source_url: sourceUrl,
      user_data: userData,
      custom_data: customData
    }]
  };

  if (META_CAPI_TEST_CODE) {
    payload.test_event_code = META_CAPI_TEST_CODE;
  }

  const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID +
              '/events?access_token=' + encodeURIComponent(token);

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  Logger.log('Meta CAPI response: ' + code + ' ' + body);

  if (code >= 200 && code < 300) {
    const parsed = JSON.parse(body);
    return { success: true, eventsReceived: parsed.events_received, fbtraceId: parsed.fbtrace_id, matchScore };
  } else {
    return { success: false, status: code, body: body, matchScore };
  }
}

/**
 * V8.2 — Envia InitiateCheckout server-side pra Meta CAPI quando user atinge
 * o checkout Kiwify (status pix_created/pending). Complementa o IC browser-side
 * que pode falhar (ad-blocker, JS desativado, etc.). event_id estável =
 * 'ic_<orderId>' permite dedup com browser caso o tag GTM IC use mesma chave.
 */
function sendInitiateCheckoutToMetaCAPI(ctx) {
  const token = getMetaCAPIToken();
  if (!token) return { skipped: true, reason: 'no_token' };

  const order = ctx.order || {};
  const customer = ctx.customer || {};
  const tracking = ctx.tracking || {};

  const orderId = String(
    order.id || order.order_id || ctx.data.order_id || ctx.data.id || ('ic_' + Date.now())
  );

  const dataEvento = order.created_at || new Date();
  const eventTime = Math.floor(new Date(dataEvento).getTime() / 1000);

  const userData = buildUserData(customer, tracking, ctx.data, ctx.params || {}, order);

  const validation = validateUserDataForCapi(userData);
  if (!validation.ok) {
    Logger.log('IC CAPI gate: ' + validation.reason);
    return { skipped: true, reason: validation.reason };
  }
  const matchScore = countMatchedFields(userData);

  // Valor estimado (mesmo do produto — IC é evento de checkout iniciado)
  const valorEstimado = 97;

  const customData = {
    currency: 'BRL',
    value: valorEstimado,
    content_name: order.Product?.product_name || order.product_name || 'Destrave Metabólico 14D',
    content_ids: [String(order.product_id || order.Product?.id || 'destrave_14d')],
    content_type: 'product',
    content_category: 'Saúde e Bem-estar',
    num_items: 1
  };

  let sourceUrl = META_EVENT_SOURCE_URL;
  const fbclid = (tracking && tracking.fbclid) || (ctx.params && ctx.params.fbclid);
  if (fbclid) sourceUrl += (sourceUrl.indexOf('?') >= 0 ? '&' : '?') + 'fbclid=' + encodeURIComponent(fbclid);

  const payload = {
    data: [{
      event_name: 'InitiateCheckout',
      event_time: eventTime,
      event_id: 'ic_' + orderId,
      action_source: 'website',
      event_source_url: sourceUrl,
      user_data: userData,
      custom_data: customData
    }]
  };
  if (META_CAPI_TEST_CODE) payload.test_event_code = META_CAPI_TEST_CODE;

  const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID +
              '/events?access_token=' + encodeURIComponent(token);
  const response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  Logger.log('Meta CAPI IC response: ' + code + ' ' + body);
  if (code >= 200 && code < 300) {
    const parsed = JSON.parse(body);
    return { success: true, eventsReceived: parsed.events_received, fbtraceId: parsed.fbtrace_id, matchScore };
  }
  return { success: false, status: code, body: body, matchScore };
}

/**
 * Função de teste manual da CAPI.
 * Antes de rodar:
 *   1. Configure META_CAPI_TOKEN nas Script Properties
 *   2. Opcionalmente, cole META_CAPI_TEST_CODE (TEST_xxxxx) na constante para
 *      ver o evento aparecer no Test Events do Events Manager.
 *   3. Execute esta função no editor
 *   4. Veja os logs em "Execução"
 */
function testarPurchaseCAPI() {
  const ctx = {
    data: { order_id: 'TEST_' + Date.now() },
    order: {
      id: 'TEST_' + Date.now(),
      created_at: new Date().toISOString(),
      product_name: 'Destrave Metabólico 14D',
      product_id: 'destrave_14d'
    },
    customer: {
      full_name: 'Cliente Teste CAPI',
      email: 'teste.capi@exemplo.com',
      mobile: '11987654321',
      CPF: '12345678900'
    },
    tracking: {
      _fbp: 'fb.1.1778078456370.735464789429373958',
      _fbc: 'fb.1.1778274879683.TESTE_CAPI'
    },
    valor: 97.00
  };
  const r = sendPurchaseToMetaCAPI(ctx);
  Logger.log(JSON.stringify(r, null, 2));
}

/**
 * Função de teste — simula um POST da Kiwify
 * Use no menu Executar para testar antes de configurar o webhook real
 */
function testarWebhookKiwify() {
  const fakePost = {
    parameter: { token: KIWIFY_WEBHOOK_TOKEN },
    postData: {
      contents: JSON.stringify({
        Order: {
          created_at: new Date().toISOString(),
          order_status: 'paid',
          product_price: 19700,
          product_name: 'Destrave Metabólico',
          tracking: {
            utm_source: 'MetaAds',
            utm_medium: 'TESTE_Conjunto',
            utm_campaign: 'TESTE_Campanha',
            utm_content: 'TESTE_AD03'
          }
        },
        Customer: {
          full_name: 'Cliente Teste',
          email: 'teste@teste.com'
        }
      })
    }
  };
  const r = doPost(fakePost);
  Logger.log(r.getContent());
}

/**
 * ============================================================
 * DEBUG V8 — Log de payloads brutos do webhook Kiwify
 * ============================================================
 * Grava cada POST que chega na aba "Webhook Debug" pra inspecionar
 * o JSON cru que a Kiwify manda. Cap automático em 50 linhas.
 *
 * Pra desligar: comente as chamadas logarPayloadDebug() em doPost().
 */
function logarPayloadDebug(rawContents, params, parsedData) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let aba = ss.getSheetByName('Webhook Debug');
    if (!aba) {
      aba = ss.insertSheet('Webhook Debug');
      const headers = ['Timestamp', 'Status', 'Order ID', 'fbp/fbc?', 'URL Params', 'Raw JSON'];
      aba.getRange(1, 1, 1, headers.length).setValues([headers]);
      aba.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#673ab7')
        .setFontColor('#ffffff');
      aba.setColumnWidth(1, 150);
      aba.setColumnWidth(2, 130);
      aba.setColumnWidth(3, 200);
      aba.setColumnWidth(4, 180);
      aba.setColumnWidth(5, 280);
      aba.setColumnWidth(6, 600);
      aba.setFrozenRows(1);
    }

    const data = parsedData || {};
    const order = data.Order || data.order || data;
    const status = (order && order.order_status) || data.webhook_event_type || data.event_name || '';
    const orderId = (order && (order.id || order.order_id)) || data.order_id || data.id || '';

    // Detecta menção a fbp/fbc em qualquer profundidade do JSON
    const flatJson = JSON.stringify(data || {});
    const temFbp = /"_?fbp"/i.test(flatJson) || /fbp[:=]/i.test(flatJson);
    const temFbc = /"_?fbc"/i.test(flatJson) || /fbc[:=]/i.test(flatJson);
    const fbpFbcStatus = (temFbp || temFbc)
      ? ('fbp:' + (temFbp ? 'SIM' : 'não') + ' | fbc:' + (temFbc ? 'SIM' : 'não'))
      : 'NENHUM';

    // Insere logo após header (linha 2) — mais novo no topo
    aba.insertRowBefore(2);
    const rawTrunc = String(rawContents || '').substring(0, 49000);
    aba.getRange(2, 1, 1, 6).setValues([[
      new Date(),
      String(status),
      String(orderId),
      fbpFbcStatus,
      JSON.stringify(params || {}),
      rawTrunc
    ]]);
    aba.getRange('A2').setNumberFormat('dd/mm/yyyy hh:mm:ss');

    // Cap em 50 linhas de dados (header + 50 = 51)
    const lastRow = aba.getLastRow();
    if (lastRow > 51) {
      aba.deleteRows(52, lastRow - 51);
    }
  } catch (debugErr) {
    Logger.log('Erro no logarPayloadDebug: ' + debugErr.toString());
  }
}

function descobrirPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const id = ss ? ss.getId() : 'NENHUMA';
  const url = ss ? ss.getUrl() : 'NENHUMA';
  const name = ss ? ss.getName() : 'NENHUMA';
  const aba = ss ? ss.getSheetByName('Vendas Kiwify') : null;
  const lastRow = aba ? aba.getLastRow() : -1;
  const ultimaLinha = aba && lastRow > 1 ? aba.getRange(lastRow, 1, 1, 12).getValues()[0] : 'sem dados';
  Logger.log('=== DIAGNÓSTICO ===');
  Logger.log('ID: ' + id);
  Logger.log('URL: ' + url);
  Logger.log('Nome: ' + name);
  Logger.log('Última linha: ' + lastRow);
  Logger.log('Conteúdo: ' + JSON.stringify(ultimaLinha));
  return { id, url, name, lastRow, ultimaLinha };
}

function testarAgendarConsultaCAPI() {
  const token = getMetaCAPIToken();
  if (!token) { Logger.log('No token'); return; }
  
  const payload = {
    data: [{
      event_name: 'AgendarConsulta',
      event_time: Math.floor(Date.now() / 1000),
      event_id: 'agendar_test_' + Date.now(),
      action_source: 'website',
      event_source_url: 'https://drdanilomatsunaga.com.br/',
      user_data: {
        em: [sha256Hex('teste@exemplo.com')],
        ph: [sha256Hex('5511987654321')],
        client_user_agent: 'Mozilla/5.0 Test'
      },
      custom_data: {
        content_name: 'Click Botao Contato',
        content_category: 'Engagement'
      }
    }],
    test_event_code: 'TEST50101'
  };
  
  const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_PIXEL_ID + '/events?access_token=' + encodeURIComponent(token);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Body: ' + response.getContentText());
}

function limparDuplicatasVendas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName('Vendas Kiwify');
  if (!aba) { Logger.log('Aba não encontrada'); return; }
  
  const lastRow = aba.getLastRow();
  if (lastRow < 2) { Logger.log('Sem dados pra limpar'); return; }
  
  // Get all data
  const numCols = aba.getLastColumn();
  const data = aba.getRange(2, 1, lastRow - 1, numCols).getValues();
  
  // Dedup by email + nome + valor + data (porque planilha atual não tem order_id)
  const seen = new Set();
  const dedup = [];
  for (const row of data) {
    const dataVenda = row[0];
    const nome = row[9];
    const email = row[10];
    const valor = row[4];
    const key = String(email) + '|' + String(nome) + '|' + String(valor) + '|' + String(dataVenda);
    if (!seen.has(key) && (nome || email)) {
      seen.add(key);
      dedup.push(row);
    }
  }
  
  Logger.log('Antes: ' + data.length + ' linhas. Depois: ' + dedup.length + ' linhas únicas.');
  
  // Limpar dados existentes
  aba.getRange(2, 1, lastRow - 1, numCols).clearContent();
  
  // Re-inserir os dedup
  if (dedup.length > 0) {
    aba.getRange(2, 1, dedup.length, dedup[0].length).setValues(dedup);
  }
  
  Logger.log('Limpeza concluída. ' + dedup.length + ' linhas mantidas.');
}

function atualizarValoresPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName('Vendas Kiwify');
  if (!aba) { Logger.log('Aba não encontrada'); return; }
  
  const lastRow = aba.getLastRow();
  if (lastRow < 2) { Logger.log('Sem dados pra atualizar'); return; }
  
  // Coluna E (5) = Valor (R$)
  // Coluna I (9) = Produto
  const valoresRange = aba.getRange(2, 5, lastRow - 1, 1);
  const produtosRange = aba.getRange(2, 9, lastRow - 1, 1);
  const valores = valoresRange.getValues();
  const produtos = produtosRange.getValues();
  
  let atualizadas = 0;
  for (let i = 0; i < valores.length; i++) {
    const valorAtual = Number(valores[i][0]);
    const produto = String(produtos[i][0] || '').toLowerCase();
    // Atualiza se valor é 0 OU vazio E produto é Destrave (ou vazio)
    if ((!valorAtual || valorAtual === 0) && (produto.includes('destrave') || produto.includes('metab') || produto === '')) {
      valores[i][0] = 97;
      atualizadas++;
    }
  }
  
  valoresRange.setValues(valores);
  Logger.log('Atualizadas ' + atualizadas + ' linhas com valor R$ 97');
}

// ============================================================
// MÓDULO KOMMO CRM — Bootstrap + Sync Incremental + Webhook
// V8.17 — adicionado em 2026-05-18
// ============================================================
//
// Roteamento:
//   doPost com `?action=kommo_webhook&key=<secret>` → handleKommoWebhook_
//
// Funções pra rodar manualmente no editor (uma vez):
//   setupKommoToken()        — salva token+secret nas Properties
//   bootstrapKommoSync()     — popula tudo do zero no Supabase
//   testarKommoConexao()     — confere se API responde
//   criarTriggerKommoSync()  — agenda sync incremental 15min
//
// Properties usadas:
//   KOMMO_TOKEN          — long-lived JWT (~800 chars)
//   KOMMO_WEBHOOK_SECRET — string aleatória pra validar webhook
//   KOMMO_LAST_SYNC_AT   — timestamp unix da última sync incremental
// ============================================================

const KOMMO_SUBDOMAIN = 'danilomatsunaga';
const KOMMO_API_BASE = 'https://' + KOMMO_SUBDOMAIN + '.kommo.com/api/v4';
const KOMMO_RATE_LIMIT_MS = 200; // 5 req/s pra ficar abaixo do limite de 7/s

// IDs dos campos custom de leads (mapeados via GET /leads/custom_fields)
const KOMMO_FIELD_IDS = {
  UTM_CONTENT:  3320126,
  UTM_MEDIUM:   3320128,
  UTM_CAMPAIGN: 3320130,
  UTM_SOURCE:   3320132,
  UTM_TERM:     3320134,
  UTM_REFERRER: 3320136,
  REFERRER:     3320138,
  GCLIENTID:    3320140,
  GCLID:        3320142,
  FBCLID:       3320144,
  TIKTOK_AD_ID: 3320166,
  TIKTOK_AD_NAME: 3320168,
  PROXIMA_CONSULTA: 3320170,
  CIDADE:       3450101,  // multiselect
  AGENDADO:     3450603
};

// Stage IDs de "Consulta agendada" em todos os pipelines (usado para auto-popular valor_fechado)
const KOMMO_CONSULTA_AGENDADA_STAGES = new Set([
  104540663, // Alphaville - Acompanhamento
  104540795, // Brasília - Acompanhamento
  104540647, // Campinas - Acompanhamento
  104924215, // CM2 - Consultas
  104544439, // Dr Felipe - Acompanhamento
  104540763, // Goiânia - Acompanhamento
  104540543, // Moema - Acompanhamento
  104540879, // Online - Acompanhamento
  104540563, // Piracicaba - Acompanhamento
  104540519  // São Paulo - Acompanhamento
]);

// ============================================================
// SETUP / TOKEN MANAGEMENT
// ============================================================

/**
 * Roda 1x no editor pra salvar credenciais Kommo em Properties.
 * Substitui os valores abaixo pelos reais ANTES de rodar.
 */
function setupKommoToken() {
  const props = PropertiesService.getScriptProperties();
  
  // SUBSTITUA AQUI:
  const TOKEN = 'COLE_LONG_LIVED_TOKEN_AQUI';
  const WEBHOOK_SECRET = 'kommo_drdanilo_' + Utilities.getUuid().slice(0, 12);
  
  if (TOKEN === 'COLE_LONG_LIVED_TOKEN_AQUI') {
    throw new Error('Cole o long-lived token no campo TOKEN antes de rodar.');
  }
  
  props.setProperty('KOMMO_TOKEN', TOKEN);
  props.setProperty('KOMMO_WEBHOOK_SECRET', WEBHOOK_SECRET);
  
  Logger.log('✅ Token Kommo salvo em Properties');
  Logger.log('✅ Webhook secret gerado: ' + WEBHOOK_SECRET);
  Logger.log('   Use essa URL no webhook do Kommo:');
  Logger.log('   ' + ScriptApp.getService().getUrl() + '?action=kommo_webhook&key=' + WEBHOOK_SECRET);
}

function getKommoToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('KOMMO_TOKEN');
  if (!t) throw new Error('KOMMO_TOKEN não configurado. Rode setupKommoToken() primeiro.');
  return t;
}

function getKommoWebhookSecret_() {
  return PropertiesService.getScriptProperties().getProperty('KOMMO_WEBHOOK_SECRET') || '';
}

// ============================================================
// HTTP CLIENT
// ============================================================

function callKommoApi_(path, options) {
  options = options || {};
  const url = KOMMO_API_BASE + path;
  const params = {
    method: options.method || 'get',
    headers: {
      'Authorization': 'Bearer ' + getKommoToken_(),
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true,
    followRedirects: true
  };
  if (options.payload) params.payload = JSON.stringify(options.payload);
  
  const resp = UrlFetchApp.fetch(url, params);
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  
  if (code === 204) return null; // No content
  
  if (code === 429) {
    // Rate limit — espera 60s e retry 1x
    Utilities.sleep(60000);
    return callKommoApi_(path, options);
  }
  if (code < 200 || code >= 300) {
    throw new Error('Kommo API ' + code + ' @ ' + path + ': ' + body.slice(0, 500));
  }
  
  try {
    return JSON.parse(body);
  } catch (e) {
    return body;
  }
}

function testarKommoConexao() {
  try {
    const data = callKommoApi_('/leads/pipelines');
    const count = (data._embedded && data._embedded.pipelines || []).length;
    Logger.log('✅ Conexão Kommo OK. ' + count + ' pipelines retornados.');
    return true;
  } catch (e) {
    Logger.log('❌ Erro: ' + e.toString());
    return false;
  }
}

// ============================================================
// MAPPERS — Kommo → Supabase
// ============================================================

function mapKommoPipeline_(p) {
  return {
    pipeline_id: p.id,
    name: p.name || '',
    sort: p.sort || 0,
    is_main: !!p.is_main,
    is_archive: !!p.is_archive,
    account_id: p.account_id || null,
    synced_at: new Date().toISOString()
  };
}

function mapKommoStage_(s, pipelineId) {
  return {
    stage_id: s.id,
    pipeline_id: pipelineId,
    name: s.name || '',
    sort: s.sort || 0,
    color: s.color || null,
    stage_type: s.type || 0,
    synced_at: new Date().toISOString()
  };
}

function mapKommoContact_(c) {
  const customFields = {};
  let phoneRaw = null;
  let email = null;
  let firstName = c.first_name || null;
  let lastName = c.last_name || null;
  
  (c.custom_fields_values || []).forEach(function(cf) {
    const code = cf.field_code || '';
    const values = (cf.values || []).map(function(v) { return v.value; });
    customFields[cf.field_name] = values.join(', ');
    if (code === 'PHONE' && values.length) phoneRaw = values[0];
    if (code === 'EMAIL' && values.length) email = String(values[0]).toLowerCase();
  });
  
  return {
    contact_id: c.id,
    name: c.name || (firstName + ' ' + (lastName || '')).trim() || null,
    first_name: firstName,
    last_name: lastName,
    phone_raw: phoneRaw,
    phone_e164: normalizePhoneE164_(phoneRaw),
    email: email,
    responsible_user_id: c.responsible_user_id || null,
    created_at: c.created_at ? new Date(c.created_at * 1000).toISOString() : null,
    updated_at: c.updated_at ? new Date(c.updated_at * 1000).toISOString() : null,
    is_deleted: !!c.is_deleted,
    custom_fields: customFields,
    synced_at: new Date().toISOString()
  };
}

function mapKommoLead_(L) {
  // Extrai custom fields organizados
  const raw = {};
  let utm = { source: null, medium: null, campaign: null, content: null, term: null };
  let gclid = null, fbclid = null, cidade = null;
  let agendadoEm = null, proximaConsultaEm = null;
  
  (L.custom_fields_values || []).forEach(function(cf) {
    const fid = cf.field_id;
    const values = (cf.values || []).map(function(v) { return v.value; });
    raw[String(fid)] = values;
    
    if (fid === KOMMO_FIELD_IDS.UTM_SOURCE)   utm.source = values[0];
    if (fid === KOMMO_FIELD_IDS.UTM_MEDIUM)   utm.medium = values[0];
    if (fid === KOMMO_FIELD_IDS.UTM_CAMPAIGN) utm.campaign = values[0];
    if (fid === KOMMO_FIELD_IDS.UTM_CONTENT)  utm.content = values[0];
    if (fid === KOMMO_FIELD_IDS.UTM_TERM)     utm.term = values[0];
    if (fid === KOMMO_FIELD_IDS.GCLID)        gclid = values[0];
    if (fid === KOMMO_FIELD_IDS.FBCLID)       fbclid = values[0];
    if (fid === KOMMO_FIELD_IDS.CIDADE)       cidade = values[0]; // multiselect: pega 1º
    if (fid === KOMMO_FIELD_IDS.AGENDADO && values[0])     agendadoEm = new Date(values[0] * 1000).toISOString();
    if (fid === KOMMO_FIELD_IDS.PROXIMA_CONSULTA && values[0]) proximaConsultaEm = new Date(values[0] * 1000).toISOString();
  });
  
  // Tags como array
  const tags = ((L._embedded && L._embedded.tags) || []).map(function(t) { return t.name; });
  
  // Contact_id principal
  let contactId = null;
  const contacts = (L._embedded && L._embedded.contacts) || [];
  for (let i = 0; i < contacts.length; i++) {
    if (contacts[i].is_main) { contactId = contacts[i].id; break; }
  }
  if (!contactId && contacts.length) contactId = contacts[0].id;
  
  // Loss reason
  let lossReason = null;
  if (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason.length) {
    lossReason = L._embedded.loss_reason[0].name || null;
  }
  
  return {
    lead_id: L.id,
    pipeline_id: L.pipeline_id || null,
    stage_id: L.status_id || null,
    name: L.name || null,
    price: Number(L.price || 0),
    responsible_user_id: L.responsible_user_id || null,
    contact_id: contactId,
    status_id: L.status_id || null,
    loss_reason_id: L.loss_reason_id || null,
    loss_reason: lossReason,
    created_by: L.created_by || null,
    updated_by: L.updated_by || null,
    created_at: L.created_at ? new Date(L.created_at * 1000).toISOString() : null,
    updated_at: L.updated_at ? new Date(L.updated_at * 1000).toISOString() : null,
    closed_at: L.closed_at ? new Date(L.closed_at * 1000).toISOString() : null,
    is_deleted: !!L.is_deleted,
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    utm_content: utm.content,
    utm_term: utm.term,
    gclid: gclid,
    fbclid: fbclid,
    cidade: cidade,
    agendado_em: agendadoEm,
    proxima_consulta_em: proximaConsultaEm,
    custom_fields_raw: raw,
    tags: tags,
    synced_at: new Date().toISOString()
  };
}

function normalizePhoneE164_(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  if (digits.length === 12 || digits.length === 13) return '+' + digits;
  return '+' + digits;
}

// ============================================================
// SUPABASE UPSERT
// ============================================================

function upsertSupabaseKommo_(table, rows) {
  if (!rows || !rows.length) return { ok: true, count: 0 };

  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) {
    throw new Error('Supabase config faltando (cfg.url=' + cfg.url + ' cfg.key=' + (cfg.key ? 'OK' : 'NULL') + ')');
  }
  const url = cfg.url + '/rest/v1/' + table + '?on_conflict=' + getKommoPrimaryKey_(table);

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('Supabase upsert err [' + table + '] HTTP ' + code + ': ' + resp.getContentText().slice(0, 400));
    return { ok: false, code: code, body: resp.getContentText() };
  }
  return { ok: true, count: rows.length };
}

function getKommoPrimaryKey_(table) {
  const map = {
    'kommo_pipelines': 'pipeline_id',
    'kommo_stages': 'pipeline_id,stage_id',  // PK composto (142/143 são compartilhados)
    'kommo_contacts': 'contact_id',
    'kommo_leads': 'lead_id',
    'kommo_stage_events': 'event_id'
  };
  return map[table] || 'id';
}

// ============================================================
// BOOTSTRAP (rodar uma vez manual)
// ============================================================

function bootstrapKommoSync() {
  Logger.log('=== BOOTSTRAP KOMMO INICIADO ===');
  const t0 = Date.now();
  
  // 1. Pipelines + Stages (vem aninhado)
  Logger.log('1/4 Puxando pipelines...');
  const pipelinesResp = callKommoApi_('/leads/pipelines');
  const pipelines = (pipelinesResp._embedded && pipelinesResp._embedded.pipelines) || [];
  
  const pipelineRows = pipelines.map(mapKommoPipeline_);
  const stageRows = [];
  pipelines.forEach(function(p) {
    const stages = (p._embedded && p._embedded.statuses) || [];
    stages.forEach(function(s) { stageRows.push(mapKommoStage_(s, p.id)); });
  });
  
  upsertSupabaseKommo_('kommo_pipelines', pipelineRows);
  upsertSupabaseKommo_('kommo_stages', stageRows);
  Logger.log('   ✅ ' + pipelineRows.length + ' pipelines + ' + stageRows.length + ' stages');
  
  Utilities.sleep(KOMMO_RATE_LIMIT_MS);
  
  // 2. Contatos (paginado)
  Logger.log('2/4 Puxando contatos...');
  let page = 1, totalContacts = 0;
  while (true) {
    const resp = callKommoApi_('/contacts?limit=250&page=' + page);
    const contacts = (resp._embedded && resp._embedded.contacts) || [];
    if (!contacts.length) break;
    
    const rows = contacts.map(mapKommoContact_);
    upsertSupabaseKommo_('kommo_contacts', rows);
    totalContacts += rows.length;
    
    Logger.log('   Page ' + page + ': ' + rows.length + ' contatos');
    if (!resp._links || !resp._links.next) break;
    page++;
    Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    
    // Safety: limita a 50 páginas (12.500 contatos) por execução
    if (page > 50) { Logger.log('   ⚠️ Atingiu 50 pages, salvando progresso e parando'); break; }
  }
  Logger.log('   ✅ ' + totalContacts + ' contatos');
  
  // 3. Leads (paginado, com contacts e loss_reason)
  Logger.log('3/4 Puxando leads...');
  page = 1; let totalLeads = 0;
  while (true) {
    const resp = callKommoApi_('/leads?with=contacts,loss_reason&limit=250&page=' + page);
    const leads = (resp._embedded && resp._embedded.leads) || [];
    if (!leads.length) break;
    
    const rows = leads.map(mapKommoLead_);
    upsertSupabaseKommo_('kommo_leads', rows);
    totalLeads += rows.length;
    
    Logger.log('   Page ' + page + ': ' + rows.length + ' leads');
    if (!resp._links || !resp._links.next) break;
    page++;
    Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    
    if (page > 50) { Logger.log('   ⚠️ Atingiu 50 pages, salvando progresso e parando'); break; }
  }
  Logger.log('   ✅ ' + totalLeads + ' leads');
  
  // 4. Stage events (histórico de movimentação dos últimos 90 dias)
  Logger.log('4/4 Puxando stage events (90d)...');
  const since90d = Math.floor((Date.now() - 90 * 86400000) / 1000);
  page = 1; let totalEvents = 0;
  while (true) {
    const resp = callKommoApi_('/events?filter[type]=lead_status_changed&filter[created_at][from]=' + since90d + '&limit=100&page=' + page);
    const events = (resp._embedded && resp._embedded.events) || [];
    if (!events.length) break;
    
    const rows = events.map(function(ev) {
      const before = (ev.value_before && ev.value_before[0] && ev.value_before[0].lead_status) || {};
      const after  = (ev.value_after  && ev.value_after[0]  && ev.value_after[0].lead_status)  || {};
      return {
        event_id: ev.id,
        lead_id: ev.entity_id,
        from_stage_id: before.id || null,
        to_stage_id: after.id || null,
        from_pipeline: before.pipeline_id || null,
        to_pipeline: after.pipeline_id || null,
        moved_at: new Date(ev.created_at * 1000).toISOString(),
        moved_by: ev.created_by || null,
        synced_at: new Date().toISOString()
      };
    });
    upsertSupabaseKommo_('kommo_stage_events', rows);
    totalEvents += rows.length;
    
    Logger.log('   Page ' + page + ': ' + rows.length + ' events');
    if (!resp._links || !resp._links.next) break;
    page++;
    Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    
    if (page > 50) { Logger.log('   ⚠️ Atingiu 50 pages, salvando progresso e parando'); break; }
  }
  Logger.log('   ✅ ' + totalEvents + ' eventos');
  
  // Salva timestamp da última sync
  PropertiesService.getScriptProperties().setProperty('KOMMO_LAST_SYNC_AT', String(Math.floor(Date.now() / 1000)));
  
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  Logger.log('=== BOOTSTRAP CONCLUÍDO em ' + elapsed + 's ===');
  Logger.log('Total: ' + pipelineRows.length + ' pipelines, ' + stageRows.length + ' stages, ' + 
             totalContacts + ' contacts, ' + totalLeads + ' leads, ' + totalEvents + ' events');
}

// ============================================================
// SYNC INCREMENTAL (rodar a cada 15min via trigger)
// ============================================================

function syncKommoIncremental() {
  const props = PropertiesService.getScriptProperties();
  const lastSync = parseInt(props.getProperty('KOMMO_LAST_SYNC_AT') || '0', 10);
  const since = lastSync || Math.floor((Date.now() - 86400000) / 1000); // fallback: 24h atrás
  
  Logger.log('=== SYNC INCREMENTAL desde ' + new Date(since * 1000).toISOString() + ' ===');
  
  // Puxa leads atualizados
  let page = 1, total = 0;
  while (true) {
    const resp = callKommoApi_('/leads?with=contacts,loss_reason&filter[updated_at][from]=' + since + '&limit=250&page=' + page);
    if (!resp) break;
    const leads = (resp._embedded && resp._embedded.leads) || [];
    if (!leads.length) break;
    
    upsertSupabaseKommo_('kommo_leads', leads.map(mapKommoLead_));
    total += leads.length;
    Logger.log('   ' + leads.length + ' leads atualizados (page ' + page + ')');
    
    if (!resp._links || !resp._links.next) break;
    page++;
    Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    if (page > 20) break; // safety
  }
  
  // Puxa eventos novos
  page = 1; let totalEv = 0;
  while (true) {
    const resp = callKommoApi_('/events?filter[type]=lead_status_changed&filter[created_at][from]=' + since + '&limit=100&page=' + page);
    if (!resp) break;
    const events = (resp._embedded && resp._embedded.events) || [];
    if (!events.length) break;
    
    const rows = events.map(function(ev) {
      const before = (ev.value_before && ev.value_before[0] && ev.value_before[0].lead_status) || {};
      const after  = (ev.value_after  && ev.value_after[0]  && ev.value_after[0].lead_status)  || {};
      return {
        event_id: ev.id,
        lead_id: ev.entity_id,
        from_stage_id: before.id || null,
        to_stage_id: after.id || null,
        from_pipeline: before.pipeline_id || null,
        to_pipeline: after.pipeline_id || null,
        moved_at: new Date(ev.created_at * 1000).toISOString(),
        moved_by: ev.created_by || null,
        synced_at: new Date().toISOString()
      };
    });
    upsertSupabaseKommo_('kommo_stage_events', rows);
    totalEv += rows.length;
    
    if (!resp._links || !resp._links.next) break;
    page++;
    Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    if (page > 20) break;
  }
  
  // Atualiza timestamp
  props.setProperty('KOMMO_LAST_SYNC_AT', String(Math.floor(Date.now() / 1000)));
  Logger.log('=== SYNC OK: ' + total + ' leads + ' + totalEv + ' events ===');

  // Extrai ref (#sp, #go, etc.) dos leads sem UTM e grava no Kommo
  try { tagarLeadsPorRef_(); } catch(e) { Logger.log('Ref tagger err: ' + e); }

  // Espelha leads na planilha
  try { sincronizarLeadsConsultaPlanilha(); } catch(e) { Logger.log('Planilha sync err: ' + e); }
}

// ============================================================
// WEBHOOK HANDLER (chamado pelo doPost quando action=kommo_webhook)
// ============================================================

function handleKommoWebhook_(params, e) {
  // Valida secret
  const secret = params.key || '';
  const expectedSecret = getKommoWebhookSecret_();
  if (!expectedSecret || secret !== expectedSecret) {
    return { error: 'invalid_secret' };
  }
  
  // Kommo manda form-encoded. Apps Script já parseia em e.parameter
  // Estrutura: leads[add][0][id]=123, leads[status][0][status_id]=456, etc.
  // Pra simplificar: re-puxamos os leads afetados via API (fresh data)

  const affectedLeadIds = new Set();
  const noteLeadUtms = {}; // {leadId: utmObj} extraído de notes[add] no payload

  // Extrai IDs dos leads mencionados em qualquer evento (add/update/status/delete)
  // E também parseia notes[add] para capturar [ref:...] em tempo real
  Object.keys(params).forEach(function(k) {
    const m = k.match(/^leads\[(?:add|update|status|delete|restore|note)\]\[(\d+)\]\[id\]$/);
    if (m) affectedLeadIds.add(params[k]);

    // Parseia notas de WhatsApp: notes[add][N][element_id] = lead_id
    const nm = k.match(/^notes\[add\]\[(\d+)\]\[element_id\]$/);
    if (nm) {
      const idx = nm[1];
      const elementType = String(params['notes[add][' + idx + '][element_type]'] || '');
      if (elementType === '2') { // 2 = lead
        const leadId = params[k];
        const text = params['notes[add][' + idx + '][params][text]'] ||
                     params['notes[add][' + idx + '][text]'] || '';
        if (text && text.indexOf('[ref:') !== -1 && !noteLeadUtms[leadId]) {
          const utms = parseRefTag_(text);
          if (utms) noteLeadUtms[leadId] = utms;
        }
      }
    }
  });

  // Aplica UTMs extraídos das notas (roda mesmo se não houver lead events)
  const utmsExtracted = Object.keys(noteLeadUtms).length;
  Object.keys(noteLeadUtms).forEach(function(leadId) {
    try {
      upsertLeadUtmsFromRef_(leadId, noteLeadUtms[leadId]);
    } catch (err) {
      Logger.log('UTM ref err lead ' + leadId + ': ' + err.toString());
    }
  });

  if (affectedLeadIds.size === 0) {
    return { ok: true, ignored: 'no_leads_in_payload', utms_extracted: utmsExtracted };
  }

  // Pra cada lead afetado, re-puxa estado atual do Kommo e faz upsert no Supabase
  const ids = Array.from(affectedLeadIds);
  const updated = [];

  for (let i = 0; i < ids.length && i < 20; i++) { // cap em 20 por webhook pra cumprir 30s
    try {
      const lead = callKommoApi_('/leads/' + ids[i] + '?with=contacts,loss_reason');
      const row = mapKommoLead_(lead);
      upsertSupabaseKommo_('kommo_leads', [row]);
      // Se o lead não tem UTMs nos campos do Kommo, busca nas notas (1ª mensagem WhatsApp)
      if (!row.utm_source) {
        extrairRefDaConversa_(ids[i]); // chama upsertLeadUtmsFromRef_ internamente se achar [ref:...]
      }
      // Auto-popula valor_fechado quando lead entra em "Consulta agendada" com price > 0
      if (KOMMO_CONSULTA_AGENDADA_STAGES.has(Number(row.stage_id)) && row.price > 0) {
        marcarValorFechado_(ids[i], row.price);
      }
      updated.push(ids[i]);
      Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    } catch (err) {
      Logger.log('Erro processando lead ' + ids[i] + ': ' + err.toString());
    }
  }

  return { ok: true, leads_processados: updated.length, ids: updated, utms_extracted: utmsExtracted };
}

// ============================================================
// [ref:...] UTM PARSER — passthrough WhatsApp → Supabase
// ============================================================

/**
 * Parseia "[ref:source|campaign|content|fbclid]" de uma string de texto.
 * Partes ausentes ficam null. Retorna null se o padrão não existir ou source estiver vazio.
 */
function parseRefTag_(text) {
  if (!text) return null;
  var m = String(text).match(/\[ref:([^\]]+)\]/);
  if (!m) return null;
  var parts = m[1].split('|');
  var utms = {
    utm_source:   parts[0] || null,
    utm_campaign: parts[1] || null,
    utm_content:  parts[2] || null,
    fbclid:       parts[3] || null
  };
  return utms.utm_source ? utms : null;
}

/**
 * Faz PATCH direto no Supabase nos campos UTM do lead — apenas se utm_source ainda for null.
 * Garante que a primeira atribuição não é sobrescrita.
 */
function upsertLeadUtmsFromRef_(leadId, utms) {
  var cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) return;
  var payload = {};
  if (utms.utm_source)   payload.utm_source   = utms.utm_source;
  if (utms.utm_campaign) payload.utm_campaign = utms.utm_campaign;
  if (utms.utm_content)  payload.utm_content  = utms.utm_content;
  if (utms.fbclid)       payload.fbclid       = utms.fbclid;
  if (!Object.keys(payload).length) return;

  var resp = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/kommo_leads?lead_id=eq.' + leadId + '&utm_source=is.null',
    {
      method: 'patch',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  Logger.log('UTM ref update lead ' + leadId + ': HTTP ' + resp.getResponseCode() +
             ' | source=' + utms.utm_source + ' campaign=' + utms.utm_campaign);
}

/**
 * Grava valor_fechado + data_fechamento no Supabase quando lead entra em "Consulta agendada".
 * Sempre sobrescreve para refletir o price atual do card no Kommo.
 */
function marcarValorFechado_(leadId, price) {
  var cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) return;
  var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  var resp = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/kommo_leads?lead_id=eq.' + leadId,
    {
      method: 'patch',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify({ valor_fechado: price, data_fechamento: today }),
      muteHttpExceptions: true
    }
  );
  Logger.log('valor_fechado lead ' + leadId + ': R$' + price + ' HTTP ' + resp.getResponseCode());
}

// ============================================================
// TRIGGER MANAGEMENT
// ============================================================

function criarTriggerKommoSync() {
  // Remove triggers antigos
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncKommoIncremental') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  // Cria trigger a cada 15min
  ScriptApp.newTrigger('syncKommoIncremental')
    .timeBased()
    .everyMinutes(15)
    .create();
  
  Logger.log('✅ Trigger syncKommoIncremental criado (15min)');
}

function removerTriggerKommoSync() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncKommoIncremental') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  Logger.log('Removidos ' + n + ' triggers');
}

// ============================================================
// HELPERS PRA DEBUG
// ============================================================

// ============================================================
// EXTRAÇÃO DE REF (#sp, #go...) DAS MENSAGENS DO KOMMO
// ============================================================
// Roda ao final de cada syncKommoIncremental.
// Para leads sem utm_campaign, busca as notas/mensagens no Kommo,
// extrai o padrão #XXX e grava no campo utm_campaign do lead.

function tagarLeadsPorRef_() {
  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) return;

  // Leads recentes sem utm_campaign no Supabase (criados últimas 48h)
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const r = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/kommo_leads?select=lead_id&utm_campaign=is.null&is_deleted=eq.false' +
    '&created_at=gte.' + cutoff + '&order=created_at.desc&limit=30',
    { headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key }, muteHttpExceptions: true }
  );
  if (r.getResponseCode() !== 200) return;

  const leads = JSON.parse(r.getContentText());
  if (!leads.length) return;
  Logger.log('Ref tagger: ' + leads.length + ' leads para verificar');

  let tagged = 0;
  for (var i = 0; i < leads.length; i++) {
    var leadId = leads[i].lead_id;
    try {
      var ref = extrairRefDaConversa_(leadId);
      if (ref) {
        atualizarCampoKommo_(leadId, ref);
        tagged++;
      }
      Utilities.sleep(KOMMO_RATE_LIMIT_MS);
    } catch (e) {
      Logger.log('Ref tagger err lead ' + leadId + ': ' + e);
    }
  }
  Logger.log('✅ Ref tagger: ' + tagged + ' leads tagados');
}

function extrairRefDaConversa_(leadId) {
  try {
    var resp = callKommoApi_('/leads/' + leadId + '/notes?limit=10&order[id]=asc');
    var notes = (resp._embedded && resp._embedded.notes) || [];
    for (var i = 0; i < notes.length; i++) {
      var params = notes[i].params || {};
      var text = params.text || params.body || notes[i].text || '';
      // Formato novo [ref:source|campaign|content|fbclid]
      if (text && text.indexOf('[ref:') !== -1) {
        var utms = parseRefTag_(text);
        if (utms) {
          upsertLeadUtmsFromRef_(leadId, utms);
          return utms.utm_campaign; // retorna campaign para compat com atualizarCampoKommo_
        }
      }
      // Formato legado #XXX
      var match = String(text).match(/#([a-z0-9_-]+)/i);
      if (match) return match[1].toLowerCase();
    }
    return null;
  } catch (e) {
    return null;
  }
}

function atualizarCampoKommo_(leadId, ref) {
  // Infere utm_source pelo prefixo do ref
  var source = 'organico';
  if (ref === 'gads' || ref.indexOf('gads') === 0) source = 'google';
  else if (ref === 'meta' || ref.indexOf('meta') === 0) source = 'facebook';
  else if (ref === 'sp' || ref === 'go' || ref === 'campinas' || ref === 'piracicaba') source = 'google';

  callKommoApi_('/leads/' + leadId, {
    method: 'patch',
    payload: {
      custom_fields_values: [
        { field_id: KOMMO_FIELD_IDS.UTM_CAMPAIGN, values: [{ value: ref }] },
        { field_id: KOMMO_FIELD_IDS.UTM_SOURCE,   values: [{ value: source }] }
      ]
    }
  });
}

// ============================================================
// ESPELHO DE LEADS KOMMO NA PLANILHA
// ============================================================
// Roda ao final de cada syncKommoIncremental (a cada 15min).
// Cria/atualiza a aba "Leads Consulta" com todos os leads ativos.

function sincronizarLeadsConsultaPlanilha() {
  const cfg = getSupabaseConfig_();
  if (!cfg.url || !cfg.key) return;

  function sbGet(path) {
    const r = UrlFetchApp.fetch(cfg.url + path, {
      headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) throw new Error('HTTP ' + r.getResponseCode());
    return JSON.parse(r.getContentText());
  }

  const leads    = sbGet('/rest/v1/kommo_leads?select=lead_id,name,pipeline_id,stage_id,cidade,utm_source,utm_campaign,created_at,updated_at&is_deleted=eq.false&order=created_at.desc&limit=2000');
  const pipelines = sbGet('/rest/v1/kommo_pipelines?select=pipeline_id,name');
  const stages   = sbGet('/rest/v1/kommo_stages?select=pipeline_id,stage_id,name,is_won,is_lost');

  const pMap = {};
  pipelines.forEach(function(p) { pMap[p.pipeline_id] = p.name; });

  const sMap = {};
  stages.forEach(function(s) { sMap[s.pipeline_id + '_' + s.stage_id] = s; });

  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let aba   = ss.getSheetByName('Leads Consulta');
  if (!aba) aba = ss.insertSheet('Leads Consulta');
  aba.clearContents();

  const header = ['ID', 'Nome', 'Pipeline', 'Etapa', 'Status', 'Cidade', 'Data Entrada', 'Última Atualização', 'UTM Source', 'UTM Campaign'];
  const rows = [header];

  leads.forEach(function(l) {
    const pName  = pMap[l.pipeline_id] || String(l.pipeline_id);
    const stage  = sMap[l.pipeline_id + '_' + l.stage_id] || {};
    const sName  = stage.name || String(l.stage_id);
    const status = stage.is_won ? 'Ganho' : stage.is_lost ? 'Perdido' : 'Ativo';
    rows.push([
      l.lead_id,
      l.name || '',
      pName,
      sName,
      status,
      l.cidade || '',
      l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '',
      l.updated_at ? new Date(l.updated_at).toLocaleString('pt-BR') : '',
      l.utm_source   || '',
      l.utm_campaign || ''
    ]);
  });

  aba.getRange(1, 1, rows.length, header.length).setValues(rows);
  // Formata cabeçalho em negrito
  aba.getRange(1, 1, 1, header.length).setFontWeight('bold');
  Logger.log('✅ Leads Consulta planilha: ' + (rows.length - 1) + ' leads');
}

// ============================================================
// QUERY LEADS HOJE — endpoint temporário de consulta
// GET /exec?action=query_leads_hoje&secret=X
// Retorna leads criados hoje com campos UTM populados
// ============================================================

function queryLeadsHoje_() {
  // Timestamp de início de hoje (BRT = UTC-3)
  const agora = new Date();
  const inicioDiaUtc = new Date(Date.UTC(
    agora.getUTCFullYear(),
    agora.getUTCMonth(),
    agora.getUTCDate(),
    3, 0, 0 // 00:00 BRT = 03:00 UTC
  ));
  const fimDiaUtc = new Date(inicioDiaUtc.getTime() + 24 * 60 * 60 * 1000);

  const desde = Math.floor(inicioDiaUtc.getTime() / 1000);
  const ate   = Math.floor(fimDiaUtc.getTime() / 1000);

  // Busca leads criados hoje (paginação até 250 por página)
  let page = 1;
  const todos = [];
  while (true) {
    const path = '/leads?filter[created_at][from]=' + desde +
      '&filter[created_at][to]=' + ate +
      '&with=contacts,custom_fields_values' +
      '&limit=250&page=' + page;
    let data;
    try {
      data = callKommoApi_(path);
    } catch (e) {
      return { error: e.toString() };
    }
    const leads = (data._embedded && data._embedded.leads) || [];
    if (leads.length === 0) break;
    todos.push.apply(todos, leads);
    if (leads.length < 250) break;
    page++;
    Utilities.sleep(KOMMO_RATE_LIMIT_MS);
  }

  // Mapear campos UTM de cada lead
  const UTM_IDS = {
    3320126: 'utm_content',
    3320128: 'utm_medium',
    3320130: 'utm_campaign',
    3320132: 'utm_source',
    3320134: 'utm_term',
    3320144: 'fbclid'
  };

  const resultado = todos.map(function(lead) {
    const utms = { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, fbclid: null };
    (lead.custom_fields_values || []).forEach(function(cf) {
      const key = UTM_IDS[cf.field_id];
      if (key) {
        const vals = (cf.values || []).map(function(v) { return v.value; });
        utms[key] = vals.length ? vals[0] : null;
      }
    });

    // Extrair telefone do contato embedado
    let telefone = null;
    const contatos = (lead._embedded && lead._embedded.contacts) || [];
    contatos.forEach(function(c) {
      (c.custom_fields_values || []).forEach(function(cf) {
        if (cf.field_code === 'PHONE' && !telefone) {
          const v = (cf.values || [])[0];
          if (v) telefone = v.value;
        }
      });
    });

    const criadoEm = new Date(lead.created_at * 1000);
    // Converter pra BRT (UTC-3)
    const criadoBrt = new Date(criadoEm.getTime() - 3 * 60 * 60 * 1000);

    const utmPreenchido = !!(utms.utm_source || utms.utm_medium || utms.utm_campaign || utms.utm_content || utms.fbclid);

    return {
      id: lead.id,
      nome: lead.name || '',
      telefone: telefone,
      status_id: lead.status_id,
      pipeline_id: lead.pipeline_id,
      criado_em_brt: criadoBrt.toISOString().replace('T', ' ').slice(0, 19),
      utm_source:   utms.utm_source,
      utm_medium:   utms.utm_medium,
      utm_campaign: utms.utm_campaign,
      utm_content:  utms.utm_content,
      utm_term:     utms.utm_term,
      fbclid:       utms.fbclid,
      utm_preenchido: utmPreenchido
    };
  });

  // Ordenar por criado_em
  resultado.sort(function(a, b) { return a.criado_em_brt.localeCompare(b.criado_em_brt); });

  const comUtm = resultado.filter(function(r) { return r.utm_preenchido; });
  const semUtm = resultado.filter(function(r) { return !r.utm_preenchido; });

  return {
    data_consulta: '2026-05-19',
    total_leads: resultado.length,
    com_utm: comUtm.length,
    sem_utm: semUtm.length,
    leads: resultado
  };
}

function statusKommo() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('KOMMO_TOKEN: ' + (props.getProperty('KOMMO_TOKEN') ? '✅ configurado' : '❌ NÃO configurado'));
  Logger.log('KOMMO_WEBHOOK_SECRET: ' + (props.getProperty('KOMMO_WEBHOOK_SECRET') || '❌ NÃO configurado'));
  const lastSync = props.getProperty('KOMMO_LAST_SYNC_AT');
  if (lastSync) {
    const dt = new Date(parseInt(lastSync) * 1000);
    Logger.log('KOMMO_LAST_SYNC_AT: ' + dt.toISOString() + ' (' + 
               Math.floor((Date.now() / 1000 - parseInt(lastSync)) / 60) + ' min atrás)');
  } else {
    Logger.log('KOMMO_LAST_SYNC_AT: nunca sincronizou');
  }
  Logger.log('Webhook URL pra colar no Kommo:');
  Logger.log('  ' + ScriptApp.getService().getUrl() + '?action=kommo_webhook&key=' + (props.getProperty('KOMMO_WEBHOOK_SECRET') || 'SECRET_NAO_DEFINIDO'));
}
