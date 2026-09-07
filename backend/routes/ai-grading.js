const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { getDb, getMainDb, runWithClass, getClassContext } = require('../db');
const { PROVIDER_PRESETS, DEFAULT_SYSTEM_PROMPT, gradePaper, testConnection } = require('../services/aiModel');

// AI 批改新上传图片：ai- 前缀标识为本功能独有，删除任务时可安全清理，
// 不会误删从考试记录复用的原图（沿用现有 uploads/ 磁盘存储风格）
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ai-' + uniqueSuffix + '-' + file.originalname);
  }
});
// 限制单文件 10MB、最多 6 张：AI 以 base64 内联传图，超大图片会使请求体与内存暴涨甚至 OOM
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 6 } });

// 包装上传中间件：把 multer 的英文错误码转成对用户友好的中文提示
const uploadImages = (req, res, next) => {
  upload.array('images', 6)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '单张试卷图片不能超过 10MB，请压缩后重试'
      : err.code === 'LIMIT_FILE_COUNT' ? '单次最多上传 6 张试卷图片'
      : '图片上传失败：' + err.message;
    return sendResponse(res, null, msg, 400);
  });
};

// 标准响应（与 teacher.js / advisor.js 保持一致）
const sendResponse = (res, data = {}, message = 'success', code = 200) => {
  const httpStatus = code >= 200 && code < 600 ? code : 500;
  res.status(httpStatus).json({ code, message, data });
};

// 中文文件名下载头（与 teacher.js 一致，避免 Node 头字符异常）
function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}

function resultLabel(r) {
  return { correct: '正确', wrong: '错误', partial: '部分正确', blank: '未作答', unknown: '待判定' }[r] || '待判定';
}

// ============ AI 配置（存主库 settings，跨班级共享；apiKey 不下发明文） ============

async function setSetting(db, key, value) {
  const existing = await db.get('SELECT key FROM settings WHERE key = ?', [key]);
  if (existing) {
    await db.run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  } else {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// ---------- 多供应商配置（存主库 settings，跨班级共享；apiKey 不下发明文） ----------
// ai_providers: 供应商数组；ai_active_provider: 当前使用的供应商 id；ai_enabled: 总开关
function genProviderId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 规范化供应商对象：补默认值、trim 关键字段；apiKey 单独传入以支持“留空则保留原值”
function normalizeProvider(raw, apiKeyOverride) {
  const p = raw || {};
  const apiKey = apiKeyOverride !== undefined ? apiKeyOverride : (p.api_key || '');
  const model = String(p.model || '').trim();
  const base_url = String(p.base_url || '').trim();
  return {
    id: p.id || genProviderId(),
    name: String(p.name || '').trim() || model || base_url || '未命名供应商',
    provider: p.provider || 'custom',
    base_url,
    api_key: apiKey,
    model,
    multimodal: p.multimodal !== undefined ? !!p.multimodal : true,
    temperature: (p.temperature !== undefined && p.temperature !== null && p.temperature !== '') ? Number(p.temperature) : 0.1,
    // max_tokens<=0 表示「不限制输出长度」：不下发该字段，交由模型按自身上下文上限自由生成。
    // 推理型模型的思考也占额度，限制过小会导致答案被截断，故默认不限制。
    max_tokens: (p.max_tokens !== undefined && p.max_tokens !== null && p.max_tokens !== '' && Number(p.max_tokens) > 0) ? Number(p.max_tokens) : 0,
    // 流式响应：默认开启（实时进度 + 空闲超时守护，慢速推理模型长卷也不会被误判超时）
    stream: p.stream !== undefined ? !!p.stream : true,
    // 思考模式：default=跟随模型（不干预）；suppress=抑制思考（best-effort 关闭 + 思考失控保护）。
    // 缺省 default，保证既有供应商行为不变。
    thinking_mode: (p.thinking_mode === 'suppress') ? 'suppress' : 'default',
    // 思考上限（字符）：仅 suppress 模式生效——思考超过此字数仍未作答即中止，防止失控空转。
    reasoning_limit: (p.reasoning_limit !== undefined && p.reasoning_limit !== null && p.reasoning_limit !== '' && Number(p.reasoning_limit) > 0) ? Number(p.reasoning_limit) : 15000,
    system_prompt: p.system_prompt !== undefined ? String(p.system_prompt) : ''
  };
}

// 读取供应商列表与激活 id；enabled 支持环境变量兜底（容器化部署）
async function loadProviders() {
  const db = await getMainDb();
  const enabledRow = await db.get("SELECT value FROM settings WHERE key = 'ai_enabled'");
  const provRow = await db.get("SELECT value FROM settings WHERE key = 'ai_providers'");
  const activeRow = await db.get("SELECT value FROM settings WHERE key = 'ai_active_provider'");
  let providers = [];
  if (provRow && provRow.value) {
    try { const arr = JSON.parse(provRow.value); if (Array.isArray(arr)) providers = arr; } catch (e) { providers = []; }
  }
  const enabled = (enabledRow && enabledRow.value === '1') || process.env.AI_ENABLED === '1';
  return { enabled: !!enabled, providers, activeId: activeRow ? activeRow.value : '' };
}

async function saveProviders(providers, activeId) {
  const db = await getMainDb();
  await setSetting(db, 'ai_providers', JSON.stringify(providers));
  if (activeId !== undefined) await setSetting(db, 'ai_active_provider', String(activeId || ''));
}

// 当前激活供应商；激活 id 失效（如被删）时回退列表首个
function resolveActive(providers, activeId) {
  if (!Array.isArray(providers) || !providers.length) return null;
  return providers.find(p => p.id === activeId) || providers[0];
}

// 批改实际使用的配置：优先激活供应商，其次环境变量兜底（AI_BASE_URL / AI_MODEL）
async function loadActiveConfig() {
  const { enabled, providers, activeId } = await loadProviders();
  let config = resolveActive(providers, activeId);
  if (!config && (process.env.AI_BASE_URL || process.env.AI_MODEL)) {
    config = {
      base_url: process.env.AI_BASE_URL || '',
      api_key: process.env.AI_API_KEY || '',
      model: process.env.AI_MODEL || '',
      multimodal: true, temperature: 0.1,
      max_tokens: Number(process.env.AI_MAX_TOKENS) || 0, // 0=不限制输出长度
      stream: process.env.AI_STREAM !== '0', // 默认开启流式
      thinking_mode: process.env.AI_THINKING_MODE === 'suppress' ? 'suppress' : 'default',
      reasoning_limit: Number(process.env.AI_REASONING_LIMIT) || 15000,
      system_prompt: ''
    };
  }
  return { enabled, config: config || { base_url: '', model: '', api_key: '' } };
}

// GET /ai-grading/presets - 模型服务商预设与默认提示词
router.get('/ai-grading/presets', async (req, res) => {
  sendResponse(res, { presets: PROVIDER_PRESETS, default_system_prompt: DEFAULT_SYSTEM_PROMPT });
});

// GET /ai-grading/config - 总开关 + 供应商列表（apiKey 掩码）+ 当前激活 id
router.get('/ai-grading/config', async (req, res) => {
  try {
    const { enabled, providers, activeId } = await loadProviders();
    const list = providers.map(p => ({
      id: p.id, name: p.name, provider: p.provider, base_url: p.base_url, model: p.model,
      multimodal: p.multimodal, temperature: p.temperature, max_tokens: p.max_tokens,
      stream: p.stream !== false, // 缺省视为开启，与 normalizeProvider 默认一致
      thinking_mode: p.thinking_mode === 'suppress' ? 'suppress' : 'default', // 缺省 default
      reasoning_limit: (p.reasoning_limit !== undefined && p.reasoning_limit !== null && Number(p.reasoning_limit) > 0) ? Number(p.reasoning_limit) : 15000,
      system_prompt: p.system_prompt, api_key_set: !!p.api_key, api_key_masked: maskKey(p.api_key)
    }));
    const active = resolveActive(providers, activeId);
    sendResponse(res, { enabled, providers: list, active_id: active ? active.id : '' });
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// PUT /ai-grading/config - 保存总开关（可一并指定当前激活供应商）
router.put('/ai-grading/config', async (req, res) => {
  try {
    const body = req.body || {};
    const enabled = (body.enabled === true || body.enabled === 1 || body.enabled === '1') ? '1' : '0';
    const db = await getMainDb();
    await setSetting(db, 'ai_enabled', enabled);
    if (body.active_id !== undefined) await setSetting(db, 'ai_active_provider', String(body.active_id || ''));
    sendResponse(res, { enabled: enabled === '1' }, '已保存');
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// POST /ai-grading/providers - 新增供应商（首个自动设为当前使用）
router.post('/ai-grading/providers', async (req, res) => {
  try {
    const { providers, activeId } = await loadProviders();
    const p = normalizeProvider(req.body || {});
    if (!p.base_url || !p.model) return sendResponse(res, null, '服务地址（base_url）与模型名（model）不能为空', 400);
    providers.push(p);
    await saveProviders(providers, activeId || p.id);
    sendResponse(res, { id: p.id, name: p.name }, '供应商已添加');
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// PUT /ai-grading/providers/:id - 编辑供应商（apiKey 留空或掩码则保留原值）
router.put('/ai-grading/providers/:id', async (req, res) => {
  try {
    const { providers, activeId } = await loadProviders();
    const idx = providers.findIndex(p => p.id === req.params.id);
    if (idx < 0) return sendResponse(res, null, '供应商不存在', 404);
    const body = req.body || {};
    let apiKey = body.api_key;
    if (apiKey === undefined || apiKey === null || apiKey === '' || String(apiKey).includes('****')) {
      apiKey = providers[idx].api_key || '';
    }
    const updated = normalizeProvider({ ...providers[idx], ...body, id: req.params.id }, apiKey);
    if (!updated.base_url || !updated.model) return sendResponse(res, null, '服务地址与模型名不能为空', 400);
    providers[idx] = updated;
    await saveProviders(providers, activeId);
    sendResponse(res, { id: updated.id, name: updated.name }, '供应商已更新');
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// DELETE /ai-grading/providers/:id - 删除供应商（删的是当前激活项则自动切到剩余首个）
router.delete('/ai-grading/providers/:id', async (req, res) => {
  try {
    const { providers, activeId } = await loadProviders();
    const next = providers.filter(p => p.id !== req.params.id);
    if (next.length === providers.length) return sendResponse(res, null, '供应商不存在', 404);
    const newActive = activeId === req.params.id ? (next.length ? next[0].id : '') : activeId;
    await saveProviders(next, newActive);
    sendResponse(res, null, '供应商已删除');
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// POST /ai-grading/providers/:id/activate - 切换当前使用的供应商
router.post('/ai-grading/providers/:id/activate', async (req, res) => {
  try {
    const { providers } = await loadProviders();
    const target = providers.find(p => p.id === req.params.id);
    if (!target) return sendResponse(res, null, '供应商不存在', 404);
    await saveProviders(providers, target.id);
    sendResponse(res, { active_id: target.id }, '已切换到「' + target.name + '」');
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// POST /ai-grading/providers/:id/test - 测试已保存供应商的连通性
router.post('/ai-grading/providers/:id/test', async (req, res) => {
  try {
    const { providers } = await loadProviders();
    const target = providers.find(p => p.id === req.params.id);
    if (!target) return sendResponse(res, null, '供应商不存在', 404);
    if (!target.base_url || !target.model) return sendResponse(res, null, '该供应商缺少服务地址或模型名', 400);
    const r = await testConnection(target);
    sendResponse(res, r, '连接成功，模型可用');
  } catch (err) {
    sendResponse(res, null, '连接失败：' + err.message, 400);
  }
});

// POST /ai-grading/test - 测试编辑中（未保存）的配置；带 provider_id 时复用其已存 apiKey
router.post('/ai-grading/test', async (req, res) => {
  try {
    const body = req.body || {};
    let apiKey = body.api_key;
    if ((!apiKey || String(apiKey).includes('****')) && body.provider_id) {
      const { providers } = await loadProviders();
      const t = providers.find(p => p.id === body.provider_id);
      if (t) apiKey = t.api_key;
    }
    const cfg = { ...body, api_key: apiKey || '' };
    if (!cfg.base_url || !cfg.model) {
      return sendResponse(res, null, '请先填写服务地址（base_url）与模型名（model）', 400);
    }
    const r = await testConnection(cfg);
    sendResponse(res, r, '连接成功，模型可用');
  } catch (err) {
    sendResponse(res, null, '连接失败：' + err.message, 400);
  }
});

// ============ AI 批改任务 ============

// 批改实时进度（taskId -> {stage, text, chars, elapsed_seconds, updated_at}）：
// 仅存内存、任务结束即清除。进度是瞬态信息无需落库；单进程部署下前端轮询 GET /tasks/:id
// 与本 Map 在同一进程，可直接读取，从而展示「模型思考中…已生成 N 字」的流式进度。
const taskProgress = new Map();

// 后台异步执行批改：脱离请求上下文，用 runWithClass 透传班级库
async function runGradingAsync(taskId, ctx, config, imageFiles, examContext) {
  if (!ctx) {
    // 班级上下文缺失（仅主库解析异常的降级路径出现）：记录告警便于排查，
    // 行为与其它路由一致（getDb 回退默认班级库），不额外中断任务
    console.warn(`[ai-grading] 任务 ${taskId} 缺少班级上下文，将回退默认班级库执行`);
  }
  const withClass = (fn) => runWithClass(ctx, fn);
  try {
    await withClass(async () => {
      const db = await getDb();
      await db.run("UPDATE ai_grading_tasks SET status='processing', updated_at=CURRENT_TIMESTAMP WHERE id=?", [taskId]);
    });

    const absPaths = imageFiles.map(f => path.join(__dirname, '..', 'uploads', f));
    // 流式进度回调：把「思考中/作答中，已生成 N 字」写入内存 Map，供前端轮询展示
    const onProgress = (p) => { taskProgress.set(String(taskId), { ...p, updated_at: Date.now() }); };
    const result = await gradePaper(config, absPaths, examContext, onProgress);

    await withClass(async () => {
      const db = await getDb();
      const detail = JSON.stringify({
        questions: result.questions,
        raw: String(result.raw || '').slice(0, 20000)
      });
      await db.run(
        `UPDATE ai_grading_tasks SET status='success', total_score=?, full_score=?, comment=?, detail=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [result.total_score, result.full_score, result.overall_comment, detail, taskId]
      );
    });
  } catch (err) {
    try {
      await withClass(async () => {
        const db = await getDb();
        await db.run(
          "UPDATE ai_grading_tasks SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
          [String(err.message || err).slice(0, 1000), taskId]
        );
      });
    } catch (e) { /* 兜底写库失败，忽略 */ }
  } finally {
    // 无论成功/失败都清理进度，避免 Map 泄漏；任务状态已落库，前端据 status 切换展示
    taskProgress.delete(String(taskId));
  }
}

// 解析 exams.content 为可读题目文本（与前端 renderContent 逻辑一致）
function examContentToText(content) {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map((q, i) => `${i + 1}. ${q.question || q.title || JSON.stringify(q)}`).join('\n');
    }
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  } catch (e) {
    return String(content);
  }
}

// GET /ai-grading/tasks - 任务列表（不含 detail 大字段）
router.get('/ai-grading/tasks', async (req, res) => {
  try {
    const db = await getDb();
    const { exam_id, student_id } = req.query;
    let sql = `
      SELECT t.id, t.exam_id, t.student_id, t.image_path, t.status, t.total_score, t.full_score,
             t.comment, t.model, t.error, t.adopted, t.adopted_at, t.created_at, t.updated_at,
             s.name AS student_name, e.title AS exam_title, e.subject AS exam_subject
      FROM ai_grading_tasks t
      LEFT JOIN students s ON t.student_id = s.id
      LEFT JOIN exams e ON t.exam_id = e.id
      WHERE 1=1
    `;
    const params = [];
    if (exam_id) { sql += ' AND t.exam_id = ?'; params.push(exam_id); }
    if (student_id) { sql += ' AND t.student_id = ?'; params.push(student_id); }
    sql += ' ORDER BY t.created_at DESC';
    const rows = await db.all(sql, params);
    // 为进行中的任务附带实时进度（内存态），供列表/详情展示
    rows.forEach(r => {
      if (r.status === 'pending' || r.status === 'processing') r.progress = taskProgress.get(String(r.id)) || null;
    });
    sendResponse(res, rows);
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// POST /ai-grading/tasks - 创建批改任务（新上传图片，或复用该生该考试已有照片）
router.post('/ai-grading/tasks', uploadImages, async (req, res) => {
  try {
    const { enabled, config } = await loadActiveConfig();
    if (!enabled) return sendResponse(res, null, 'AI 批改功能未开启，请先在「模型配置」中开启并保存', 400);
    if (!config.base_url || !config.model) {
      return sendResponse(res, null, '模型未正确配置（缺少服务地址或模型名），请先完成配置', 400);
    }

    const { exam_id, student_id } = req.body;
    if (!exam_id || !student_id) return sendResponse(res, null, 'exam_id 与 student_id 不能为空', 400);

    const db = await getDb();
    const exam = await db.get('SELECT id, title, subject, content FROM exams WHERE id = ?', [exam_id]);
    if (!exam) return sendResponse(res, null, '试卷不存在', 404);
    const student = await db.get('SELECT id, name FROM students WHERE id = ?', [student_id]);
    if (!student) return sendResponse(res, null, '学生不存在', 404);

    // 图片来源：优先本次上传；否则复用该生该考试记录里已有的试卷照片
    let imageFiles = [];
    if (req.files && req.files.length) {
      imageFiles = req.files.map(f => f.filename);
    } else {
      const rec = await db.get('SELECT image_path FROM exam_records WHERE exam_id = ? AND student_id = ?', [exam_id, student_id]);
      if (rec && rec.image_path) imageFiles = rec.image_path.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!imageFiles.length) {
      return sendResponse(res, null, '请上传试卷图片，或确保该学生已有试卷照片', 400);
    }

    const result = await db.run(
      `INSERT INTO ai_grading_tasks (exam_id, student_id, image_path, status, model) VALUES (?, ?, ?, 'pending', ?)`,
      [exam_id, student_id, imageFiles.join(','), config.model]
    );
    const taskId = result.lastID;

    const ctx = getClassContext();
    const examContext = { title: exam.title, subject: exam.subject, content: examContentToText(exam.content) };
    // 后台执行，不阻塞响应（LLM 调用耗时长，前端改为轮询任务状态）
    runGradingAsync(taskId, ctx, config, imageFiles, examContext);

    sendResponse(res, { id: taskId, status: 'pending' });
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// GET /ai-grading/tasks/:id - 任务详情（解析 detail）
router.get('/ai-grading/tasks/:id', async (req, res) => {
  try {
    const db = await getDb();
    const row = await db.get(`
      SELECT t.*, s.name AS student_name, e.title AS exam_title, e.subject AS exam_subject
      FROM ai_grading_tasks t
      LEFT JOIN students s ON t.student_id = s.id
      LEFT JOIN exams e ON t.exam_id = e.id
      WHERE t.id = ?
    `, [req.params.id]);
    if (!row) return sendResponse(res, null, '任务不存在', 404);
    let detail = null;
    if (row.detail) {
      try { detail = JSON.parse(row.detail); } catch (e) { detail = null; }
    }
    row.detail = detail;
    // 进行中附带实时进度（内存态）：前端详情弹窗每 2.5s 轮询即可看到「已生成 N 字」
    row.progress = (row.status === 'pending' || row.status === 'processing')
      ? (taskProgress.get(String(row.id)) || null)
      : null;
    sendResponse(res, row);
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// POST /ai-grading/tasks/:id/adopt - 采纳成绩：写回考试记录并同步成绩分析
router.post('/ai-grading/tasks/:id/adopt', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const task = await db.get('SELECT * FROM ai_grading_tasks WHERE id = ?', [id]);
    if (!task) return sendResponse(res, null, '任务不存在', 404);
    if (task.status !== 'success') return sendResponse(res, null, '该任务尚未批改成功，无法采纳', 400);

    // 老师拥有最终决定权：可用 body.score / body.comment 覆盖 AI 结果
    let score = task.total_score;
    if (req.body.score !== undefined && req.body.score !== null && req.body.score !== '') {
      const n = Number(req.body.score);
      // 防御非法分数：NaN 会被 sqlite 静默存成 NULL，进而连带清空该生在成绩分析中的记录
      if (!Number.isFinite(n) || n < 0) {
        return sendResponse(res, null, '分数非法，请输入 0 或正数', 400);
      }
      score = n;
    }
    const comment = req.body.comment !== undefined ? req.body.comment : (task.comment || '');

    // 写入/更新考试记录
    let rec = await db.get('SELECT id FROM exam_records WHERE exam_id = ? AND student_id = ?', [task.exam_id, task.student_id]);
    let recId;
    if (rec) {
      recId = rec.id;
      await db.run('UPDATE exam_records SET score = ?, comment = ? WHERE id = ?', [score, comment, recId]);
    } else {
      const r = await db.run('INSERT INTO exam_records (exam_id, student_id, score, comment) VALUES (?, ?, ?, ?)',
        [task.exam_id, task.student_id, score, comment]);
      recId = r.lastID;
    }

    // 同步成绩分析（scores 表），逻辑与 teacher.js 更新考试记录一致
    const record = await db.get(
      'SELECT er.student_id, er.score, e.title AS exam_title, e.subject AS exam_subject FROM exam_records er LEFT JOIN exams e ON er.exam_id = e.id WHERE er.id = ?',
      [recId]
    );
    if (record && record.exam_title) {
      await db.run('DELETE FROM scores WHERE exam_name = ? AND student_id = ?', [record.exam_title, record.student_id]);
      if (record.score !== null && record.score !== undefined && record.score !== '') {
        const existSubject = await db.get("SELECT subject FROM scores WHERE exam_name = ? AND subject IS NOT NULL AND subject != ? LIMIT 1", [record.exam_title, '']);
        const subject = record.exam_subject || (existSubject ? existSubject.subject : '综合');
        await db.run('INSERT INTO scores (student_id, subject, score, exam_name) VALUES (?, ?, ?, ?)',
          [record.student_id, subject, record.score, record.exam_title]);
      }
    }

    await db.run('UPDATE ai_grading_tasks SET adopted = 1, adopted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    sendResponse(res, { id, score, exam_record_id: recId }, '已采纳到成绩');
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// DELETE /ai-grading/tasks/:id - 删除任务（仅清理本功能新上传的 ai- 图片）
router.delete('/ai-grading/tasks/:id', async (req, res) => {
  try {
    const db = await getDb();
    const task = await db.get('SELECT image_path FROM ai_grading_tasks WHERE id = ?', [req.params.id]);
    if (task && task.image_path) {
      task.image_path.split(',').map(s => s.trim()).filter(Boolean).forEach(f => {
        // 仅清理本功能新上传（ai- 前缀）的图片；basename 去掉任何目录成分并要求与原值一致、
        // 且不含 ..，防止 image_path 被构造成穿越到 uploads/ 之外造成误删
        const base = path.basename(f);
        if (base === f && base.startsWith('ai-') && !f.includes('..')) {
          const fp = path.join(__dirname, '..', 'uploads', base);
          if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) { /* 忽略 */ } }
        }
      });
    }
    await db.run('DELETE FROM ai_grading_tasks WHERE id = ?', [req.params.id]);
    sendResponse(res, { id: req.params.id });
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

// GET /ai-grading/tasks/:id/export - 导出批改文档（概览 + 逐题明细）
router.get('/ai-grading/tasks/:id/export', async (req, res) => {
  try {
    const db = await getDb();
    const row = await db.get(`
      SELECT t.*, s.name AS student_name, e.title AS exam_title
      FROM ai_grading_tasks t
      LEFT JOIN students s ON t.student_id = s.id
      LEFT JOIN exams e ON t.exam_id = e.id
      WHERE t.id = ?
    `, [req.params.id]);
    if (!row) return sendResponse(res, null, '任务不存在', 404);

    let detail = { questions: [] };
    if (row.detail) { try { detail = JSON.parse(row.detail) || detail; } catch (e) { /* 用默认 */ } }
    const questions = Array.isArray(detail.questions) ? detail.questions : [];

    const overview = [
      { '项目': '试卷', '内容': row.exam_title || '' },
      { '项目': '学生', '内容': row.student_name || '' },
      { '项目': '批改模型', '内容': row.model || '' },
      { '项目': 'AI 判分', '内容': `${row.total_score ?? ''} / ${row.full_score ?? ''}` },
      { '项目': '采纳状态', '内容': row.adopted ? '已采纳' : '未采纳' },
      { '项目': '批改时间', '内容': row.updated_at || row.created_at || '' },
      { '项目': '总评', '内容': row.comment || '' }
    ];
    const qdata = questions.map(q => ({
      '题号': q.no, '题目': q.question, '学生作答': q.student_answer,
      '得分': q.score, '满分': q.full_score, '判定': resultLabel(q.result), '点评': q.comment
    }));

    const wb = xlsx.utils.book_new();
    const ws1 = xlsx.utils.json_to_sheet(overview);
    ws1['!cols'] = [{ wch: 12 }, { wch: 70 }];
    const ws2 = xlsx.utils.json_to_sheet(qdata);
    ws2['!cols'] = [{ wch: 8 }, { wch: 32 }, { wch: 32 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 40 }];
    xlsx.utils.book_append_sheet(wb, ws1, '批改概览');
    xlsx.utils.book_append_sheet(wb, ws2, '逐题明细');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition(`${row.exam_title || '试卷'}_${row.student_name || '学生'}_AI批改.xlsx`));
    res.send(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (err) {
    sendResponse(res, null, err.message, 500);
  }
});

module.exports = router;
