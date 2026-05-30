// ============================================================
// factcheck-api.js — 真相雷達後端 API 封裝
// 在前端引入此檔案即可使用所有後端功能
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── 設定（上線前換成你的 Supabase 專案資訊）────────────────────
const SUPABASE_URL  = 'https://jbkirzfdshmruhuymaom.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impia2lyemZkc2htcnVodXltYW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MTY1NDAsImV4cCI6MjA5NTA5MjU0MH0.rP8Ch6tSJ3qnQAAjBqIVlCef1Nm5LS_NmBwiDnECQGQ';
const COFACTS_API   = 'https://cofacts-proxy2.jmyyeh28.workers.dev';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── 工具函式 ──────────────────────────────────────────────────
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ============================================================
// AUTH — 帳號管理
// ============================================================

/** 註冊 */
export async function signUp(email, password, nickname) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { nickname } }
  });
  if (error) throw error;
  return data;
}

/** 登入 */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/** 登出 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** 取得目前登入用戶 */
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from('profiles').select('*').eq('id', user.id).single();
  return { ...user, profile };
}

/** 監聽登入狀態變化 */
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
}

// ============================================================
// QUERY CACHE — 查核快取（加速 Cofacts API）
// ============================================================

const COFACTS_QUERY = `
  query SearchArticles($text: String!) {
    ListArticles(
      filter: { moreLikeThis: { like: $text } }
      orderBy: [{ _score: DESC }]
      first: 5
    ) {
      edges {
        score
        node {
          id text createdAt articleType
          articleReplies(status: NORMAL) {
            reply { id type text reference }
            positiveFeedbackCount
          }
        }
      }
    }
  }
`;

/**
 * 查核訊息（優先讀快取，快取失效才打 Cofacts API）
 * @returns {{ verdict, summary, confidence, sources, similar, fromCache }}
 */
export async function checkMessage(queryText) {
  const hash = await sha256(queryText);

  // 1. 查快取
  const { data: cached } = await supabase
    .from('query_cache')
    .select('*')
    .eq('query_hash', hash)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (cached) {
    // 命中：更新 hit_count
    await supabase.from('query_cache')
      .update({ hit_count: cached.hit_count + 1 })
      .eq('id', cached.id);

    return {
      verdict:    cached.verdict,
      summary:    cached.summary,
      confidence: cached.confidence,
      sources:    cached.raw_response?.sources ?? ['Cofacts（快取）'],
      similar:    cached.raw_response?.similar ?? [],
      fromCache:  true,
    };
  }

  // 2. 快取未命中 → 打 Cofacts API
  const res = await fetch(COFACTS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: COFACTS_QUERY, variables: { text: queryText } })
  });
  if (!res.ok) throw new Error('Cofacts API 連線失敗');
  const json = await res.json();

  const edges = json.data?.ListArticles?.edges ?? [];
  const result = parseCofactsResult(edges);

  // 3. 寫入快取
  await supabase.from('query_cache').upsert({
    query_hash:   hash,
    query_text:   queryText,
    verdict:      result.verdict,
    summary:      result.summary,
    confidence:   result.confidence,
    raw_response: { sources: result.sources, similar: result.similar },
    expires_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }, { onConflict: 'query_hash' });

  return { ...result, fromCache: false };
}

function parseCofactsResult(edges) {
  const VERDICT_CONF = { RUMOR: 88, OPINIONATED: 65, NOT_ARTICLE: 60, USEFUL: 92, unknown: 35 };

  if (!edges.length || edges[0].score < 1) {
    return {
      verdict: 'unknown', confidence: 35,
      summary: '目前 Cofacts 資料庫中沒有找到與此訊息高度相似的查核紀錄。建議保持謹慎並透過回報功能協助送出。',
      sources: ['Cofacts 開放資料庫'], similar: [],
    };
  }

  const top = edges[0].node;
  const replies = top.articleReplies ?? [];

  // 取票數最多的 verdict
  const counts = {};
  for (const ar of replies) {
    counts[ar.reply.type] = (counts[ar.reply.type] ?? 0) + (ar.positiveFeedbackCount || 1);
  }
  const verdict = replies.length
    ? Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0]
    : 'unknown';

  const bestReply = [...replies]
    .sort((a,b) => (b.positiveFeedbackCount??0) - (a.positiveFeedbackCount??0))[0];
  const summary = bestReply?.reply.text?.slice(0, 300) ?? '查核人員已標記但尚無詳細說明。';

  const sources = ['Cofacts 開放資料庫'];
  for (const ar of replies) {
    if (ar.reply.reference) sources.push(ar.reply.reference.slice(0, 60));
  }

  const similar = edges.slice(1, 4).map(e => ({
    text:    (e.node.text ?? '').slice(0, 80),
    verdict: verdictFromReplies(e.node.articleReplies),
  }));

  return { verdict, summary, confidence: VERDICT_CONF[verdict] ?? 50, sources, similar };
}

function verdictFromReplies(articleReplies) {
  if (!articleReplies?.length) return 'unknown';
  const counts = {};
  for (const ar of articleReplies) {
    counts[ar.reply.type] = (counts[ar.reply.type] ?? 0) + (ar.positiveFeedbackCount || 1);
  }
  return Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
}

// ============================================================
// REPORTS — 用戶回報
// ============================================================

/**
 * 送出回報（允許匿名）
 */
export async function submitReport({ content, source, category, userNote }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('reports').insert({
    user_id:   user?.id ?? null,
    content,
    source:    source || null,
    category:  category || null,
    user_note: userNote || null,
    status:    'pending',
  }).select().single();
  if (error) throw error;
  return data;
}

/**
 * 取得目前登入用戶自己的回報列表
 */
export async function getMyReports() {
  const { data, error } = await supabase
    .from('reports')
    .select('id, content, category, status, created_at, admin_note')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ============================================================
// ADMIN — 管理員功能
// ============================================================

/**
 * 取得所有回報（管理員）
 */
export async function adminGetReports({ status = null, limit = 50, offset = 0 } = {}) {
  let q = supabase
    .from('reports')
    .select(`
      id, content, source, category, user_note,
      status, admin_note, created_at, updated_at,
      profiles:user_id ( email, nickname )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);
  const { data, error, count } = await q;
  if (error) throw error;
  return { data, total: count };
}

/**
 * 更新回報狀態（管理員）
 */
export async function adminUpdateReport(reportId, { status, adminNote }) {
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('reports')
    .update({
      status,
      admin_note:   adminNote ?? null,
      reviewed_by:  user.id,
      reviewed_at:  new Date().toISOString(),
    })
    .eq('id', reportId)
    .select().single();
  if (error) throw error;

  // 寫操作日誌
  await supabase.from('admin_logs').insert({
    admin_id:    user.id,
    action:      'review',
    target_type: 'report',
    target_id:   reportId,
    detail:      { status, adminNote },
  });

  return data;
}

/**
 * 取得快取統計（管理員）
 */
export async function adminGetCacheStats() {
  const { count: total }   = await supabase.from('query_cache').select('*', { count: 'exact', head: true });
  const { count: expired } = await supabase.from('query_cache')
    .select('*', { count: 'exact', head: true })
    .lt('expires_at', new Date().toISOString());
  const { data: topHits } = await supabase.from('query_cache')
    .select('query_text, hit_count, verdict')
    .order('hit_count', { ascending: false })
    .limit(10);
  return { total, expired, topHits };
}

/**
 * 清除過期快取（管理員）
 */
export async function adminPurgeCache() {
  const { error } = await supabase.rpc('purge_expired_cache');
  if (error) throw error;
}

/**
 * 修改用戶角色（管理員）
 */
export async function adminSetRole(userId, role) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('profiles').update({ role }).eq('id', userId).select().single();
  if (error) throw error;
  await supabase.from('admin_logs').insert({
    admin_id: user.id, action: 'role_change',
    target_type: 'user', target_id: userId,
    detail: { role },
  });
  return data;
}
