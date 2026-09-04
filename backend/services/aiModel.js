// ============================================================
// AI 试卷批改 - 模型调用服务层
// 统一走 OpenAI 兼容协议（Chat Completions），一套逻辑覆盖：
//   官方 Qwen-VL / DeepSeek-Vision / 本地 Ollama / OpenAI 及任意兼容中转
// 仅依赖 Node 18+ 内置 fetch，不引入新三方包，避免影响 Alpine 构建与 /deps 卷。
// ============================================================

const fs = require('fs');
const path = require('path');

// 模型服务商预设：前端选择后自动回填 base_url / model，用户仍可自由修改
const PROVIDER_PRESETS = [
  {
    key: 'deepseek',
    label: 'DeepSeek（默认）',
    base_url: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash-vision-exp',
    multimodal: true,
    hint: '默认供应商；请填写支持视觉的模型名，DeepSeek 纯文本模型无法读取图片'
  },
  {
    key: 'qwen',
    label: '通义千问 Qwen-VL（官方）',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    multimodal: true,
    hint: '阿里云百炼，OpenAI 兼容，原生支持 OCR 与图像理解'
  },
  {
    key: 'ollama',
    label: '本地 Ollama',
    base_url: 'http://localhost:11434/v1',
    model: 'qwen2.5vl',
    multimodal: true,
    hint: '本地部署、数据不出域；需先 ollama pull 视觉模型（如 qwen2.5vl / llava / minicpm-v）。Docker 内访问宿主机请改用 http://host.docker.internal:11434/v1'
  },
  {
    key: 'openai',
    label: 'OpenAI / 兼容中转',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    multimodal: true,
    hint: '任意 OpenAI 兼容端点，可填写第三方中转站 base_url 与模型名'
  },
  {
    key: 'custom',
    label: '自定义',
    base_url: '',
    model: '',
    multimodal: true,
    hint: '手动填写 base_url、模型名与密钥，适配自建或其它兼容服务'
  }
];

// 默认批改系统提示词：约束模型只依据图片判分并严格输出 JSON
const DEFAULT_SYSTEM_PROMPT = `你是一名严谨、经验丰富的小学教师，正在批改学生的试卷。请仔细观察试卷图片，完成以下工作：
1. 逐题识别题号、题目内容、学生的作答内容；
2. 判断每道题的对错并给出该题得分；
3. 汇总学生总得分与试卷满分；
4. 给出总体评语，指出主要问题与改进建议。

判分要求：
- 只依据图片中可见的作答内容判分，无法辨认或未作答的题目按 0 分处理，并在该题点评中说明；
- 客观题按对错判分，主观题按要点给分，允许给出部分分；
- 保持严格、公正，分数为数字，不要带单位。

输出要求（非常重要）：
- 必须严格输出一个 JSON 对象，不要输出任何解释性文字、前后缀或 Markdown 代码块；
- JSON 结构如下：
{
  "full_score": 数字,            // 试卷满分，无法确定时用各题满分之和
  "total_score": 数字,           // 学生实际总得分
  "overall_comment": "总体评语",
  "questions": [
    {
      "no": "题号",              // 如 "1" 或 "一"
      "question": "题目内容摘要",
      "student_answer": "识别到的学生作答内容",
      "score": 数字,             // 本题得分
      "full_score": 数字,        // 本题满分
      "result": "correct",       // 只能是 correct / wrong / partial / blank 之一
      "comment": "本题点评"
    }
  ]
}`;

// ---------- 小工具 ----------
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function normalizeResult(v) {
  const s = str(v).toLowerCase();
  if (['correct', 'right', 'true', '对', '正确', 'full'].includes(s)) return 'correct';
  if (['wrong', 'false', '错', '错误', 'incorrect'].includes(s)) return 'wrong';
  if (['partial', 'part', '部分', 'half'].includes(s)) return 'partial';
  if (['blank', 'empty', '未答', '空', 'none'].includes(s)) return 'blank';
  return 'unknown';
}

// 归一化 base_url 为完整的 chat/completions 端点
function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || !String(baseUrl).trim()) {
    throw new Error('未配置模型服务地址（base_url）');
  }
  let u = String(baseUrl).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
  };
  return map[ext] || 'image/jpeg';
}

// 读取本地图片文件转为 base64 data URL（OpenAI 兼容端点内联传图方式）
// 用异步读取，避免大图 readFileSync 阻塞事件循环（影响轮询等其它请求）
async function imageToDataUrl(absPath) {
  let buf;
  try {
    buf = await fs.promises.readFile(absPath);
  } catch (e) {
    throw new Error(`图片文件不存在或无法读取：${path.basename(absPath)}`);
  }
  return `data:${mimeOf(absPath)};base64,${buf.toString('base64')}`;
}

// ---------- 消息构建 ----------
function buildUserText(examContext = {}) {
  const lines = ['请批改这张（或这组）试卷图片，并按系统提示词要求输出 JSON。'];
  if (examContext.title) lines.push(`试卷标题：${examContext.title}`);
  if (examContext.subject) lines.push(`科目：${examContext.subject}`);
  if (examContext.content) {
    lines.push('试卷题目参考（可能不完整，请以图片实际内容为准）：');
    lines.push(str(examContext.content).slice(0, 2000));
  }
  return lines.join('\n');
}

function buildGradingMessages(config, imageDataUrls, examContext) {
  const system = (config.system_prompt && String(config.system_prompt).trim()) || DEFAULT_SYSTEM_PROMPT;
  const content = [{ type: 'text', text: buildUserText(examContext) }];
  for (const url of imageDataUrls) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  return [
    { role: 'system', content: system },
    // 图片仅放在 user 消息中：部分兼容端点（如 DeepSeek）禁止 system/assistant 消息含图
    { role: 'user', content }
  ];
}

// ---------- 结果解析 ----------
function extractJsonText(text) {
  let s = str(text).trim();
  if (!s) return s;
  // 去掉 ```json ... ``` 或 ``` ... ``` 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 截取第一个 { 到最后一个 } 之间的内容，容忍模型输出的多余前后缀
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

function normalizeQuestion(q, i) {
  if (!q || typeof q !== 'object') return null;
  return {
    no: str(q.no ?? q.number ?? q.index ?? q['题号'] ?? i + 1),
    question: str(q.question ?? q.title ?? q['题目'] ?? ''),
    student_answer: str(q.student_answer ?? q.answer ?? q['学生答案'] ?? q['作答'] ?? ''),
    score: num(q.score ?? q['得分'] ?? q['分数'], 0),
    full_score: num(q.full_score ?? q.max_score ?? q.fullscore ?? q['满分'], 0),
    result: normalizeResult(q.result ?? q.status ?? q['结果']),
    comment: str(q.comment ?? q.feedback ?? q['点评'] ?? q['评语'] ?? '')
  };
}

function parseGradingResult(text) {
  if (!text || !str(text).trim()) {
    throw new Error('模型未返回任何内容');
  }
  const jsonStr = extractJsonText(text);
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`模型返回内容无法解析为 JSON（${e.message}）。原始返回片段：${str(text).slice(0, 400)}`);
  }
  const questions = Array.isArray(obj.questions)
    ? obj.questions.map(normalizeQuestion).filter(Boolean)
    : [];
  const sumFull = questions.reduce((s, q) => s + q.full_score, 0);
  const sumScore = questions.reduce((s, q) => s + q.score, 0);
  return {
    full_score: num(obj.full_score ?? obj.max_score, sumFull),
    total_score: num(obj.total_score ?? obj.score, sumScore),
    overall_comment: str(obj.overall_comment ?? obj.comment ?? obj['总评'] ?? ''),
    questions
  };
}

// ---------- 核心调用 ----------
async function callChatCompletion(config, messages, { timeoutMs = 180000 } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本过低，缺少内置 fetch，请升级到 Node 18+');
  }
  const url = normalizeBaseUrl(config.base_url);
  const headers = { 'Content-Type': 'application/json' };
  if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`;

  const body = {
    model: config.model,
    messages,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.1,
    max_tokens: num(config.max_tokens, 3000),
    stream: false
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // await resp.text() 必须仍在超时保护内：Node fetch 在响应头到达即 resolve，
    // 若提前 clearTimeout，上游“发头不发体”的半开连接会让 text() 永久挂起、任务卡在 processing。
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text.slice(0, 400);
      try {
        const errObj = JSON.parse(text);
        detail = errObj?.error?.message || errObj?.message || detail;
      } catch (e) { /* 保留原始文本 */ }
      throw new Error(`模型接口返回 ${resp.status}：${detail}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`模型返回非 JSON 内容：${text.slice(0, 300)}`);
    }
    const choice = data?.choices?.[0];
    // 输出被 max_tokens 截断时 JSON 往往不完整，给出可操作提示而非笼统的“无法解析”
    if (choice?.finish_reason === 'length') {
      throw new Error('模型输出被截断（达到最大 Tokens 上限），请在配置中调大「最大 Tokens」或减少单次上传的图片数量');
    }
    const content = choice?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => c?.text || '').join('');
    throw new Error('模型返回内容为空或结构异常（未找到 choices[0].message.content）');
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`调用模型超时（>${Math.round(timeoutMs / 1000)}s），请检查网络或改用更快的模型`);
    }
    // fetch 网络层错误（DNS/连接失败等）为 TypeError，转成更友好的提示；业务/解析错误原样抛出
    if (e instanceof TypeError) {
      throw new Error(`无法连接模型服务：${e.message}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 批改主入口：config + 图片绝对路径数组 + 试卷上下文 -> 结构化批改结果
async function gradePaper(config, imageAbsPaths, examContext = {}) {
  if (!Array.isArray(imageAbsPaths) || imageAbsPaths.length === 0) {
    throw new Error('没有可批改的试卷图片');
  }
  if (!config || !config.model) {
    throw new Error('未配置模型名称（model）');
  }
  const dataUrls = await Promise.all(imageAbsPaths.map(imageToDataUrl));
  const messages = buildGradingMessages(config, dataUrls, examContext);
  const raw = await callChatCompletion(config, messages);
  const result = parseGradingResult(raw);
  result.raw = raw; // 保留原始返回，便于排查与二期复用
  return result;
}

// 测试连接：发送一个最小文本请求，验证 base_url / api_key / model 是否可用
// 超时 20s（低于前端 axios 的 30s），保证上游慢时前端能收到后端的友好错误而非 axios 超时
async function testConnection(config) {
  const messages = [{ role: 'user', content: '连接测试，请只回复两个字：正常' }];
  const raw = await callChatCompletion(config, messages, { timeoutMs: 20000 });
  return { ok: true, reply: str(raw).slice(0, 100) };
}

module.exports = {
  PROVIDER_PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  normalizeBaseUrl,
  parseGradingResult,
  gradePaper,
  testConnection
};
