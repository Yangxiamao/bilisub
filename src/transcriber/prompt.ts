import type { Cue, PromptCtx } from './types';

/** Bump whenever prompt wording or output format changes (part of the cache key). */
export const PROMPT_VERSION = 'p2';

export type OutputFormat = 'compact' | 'json';

const MAX_DESC = 200;
const MAX_TAGS = 15;

function contextLines(ctx: PromptCtx): string {
  const lines: string[] = [];
  if (ctx.title) lines.push(`视频标题：${ctx.title}`);
  if (ctx.tags?.length) lines.push(`标签：${ctx.tags.slice(0, MAX_TAGS).join('、')}`);
  const desc = ctx.desc?.replace(/\s+/g, ' ').trim();
  if (desc && desc !== '-') lines.push(`简介：${desc.length > MAX_DESC ? `${desc.slice(0, MAX_DESC)}…` : desc}`);
  return lines.length ? `\n以下信息仅用于参考专有名词的写法，不要把它们当作音频内容输出：\n${lines.join('\n')}\n` : '';
}

export function buildPrompt(ctx: PromptCtx, durationSec: number, format: OutputFormat): string {
  const fmt = format === 'compact'
    ? '每条字幕一行，格式为：开始秒|结束秒|文字\n例如：3.2|5.8|这辆坦克我们先拿下'
    : '按给定的 JSON 结构输出，s 为开始秒，e 为结束秒，t 为文字';
  return `你是中文字幕听写员。这段音频长 ${durationSec.toFixed(1)} 秒，来自一个 B 站视频。
请把音频里所有清晰的人声对白（解说、游戏角色台词等）逐字听写成简体中文字幕。

规则：
1. 只听写，不翻译、不总结、不改写。一律使用简体字，不要出现繁体字。英文单词、游戏术语和专有名词保持原样。
2. 不要转写歌词、BGM、音效，也不要输出［笑声］［炮火声］之类的标注。
3. 听不清的部分直接跳过，绝对不要编造。整段没有人声时什么都不输出。
4. 时间以秒为单位，从音频开头算起，保留 1 位小数，要和说话的实际时间对齐。
5. 每条不超过 20 个汉字，长句按语义拆成多条。保留逗号、问号、感叹号，句末不加句号。
${contextLines(ctx)}
${fmt}
只输出字幕，不要输出任何其他内容。`;
}

/** JSON schema for format === 'json'. Kept tiny: short keys = fewer output tokens. */
export const CUE_SCHEMA = {
  type: 'object',
  properties: {
    cues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { s: { type: 'number' }, e: { type: 'number' }, t: { type: 'string' } },
        required: ['s', 'e', 't'],
      },
    },
  },
  required: ['cues'],
} as const;

/** "12.3", "1:02.5", "00:01:02.5" -> seconds */
function parseClock(s: string): number {
  const parts = s.trim().split(':');
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const LINE_RE = /^\s*(?:\d+[.、)]\s+)?\[?((?:\d+:)*\d+(?:\.\d+)?)\s*(?:\||-->|–|-|~|,)\s*((?:\d+:)*\d+(?:\.\d+)?)\]?\s*[|:：]?\s*(.+?)\s*$/;

/** Parse `start|end|text` lines. Tolerates a few formatting slips models make. */
export function parseCompact(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of text.replace(/```[a-z]*\n?/gi, '').split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const from = parseClock(m[1]);
    const to = parseClock(m[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    cues.push({ from, to, content: m[3] });
  }
  return cues;
}

export function parseJsonCues(text: string): Cue[] {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  const data = JSON.parse(cleaned) as { cues?: Array<{ s: number; e: number; t: string }> };
  return (data.cues ?? [])
    .filter((c) => typeof c?.t === 'string' && Number.isFinite(c.s) && Number.isFinite(c.e))
    .map((c) => ({ from: c.s, to: c.e, content: c.t }));
}
