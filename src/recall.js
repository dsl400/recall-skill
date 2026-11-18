#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { decodeHTML } from 'entities';
import { Parser } from 'htmlparser2';
import { lexer, walkTokens } from 'marked';

const DROPPED_TAGS = new Set([
  'system-reminder', 'ide_opened_file', 'ide_selection',
  'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'command-message',
]);
const UNWRAPPED_TAGS = new Set(['command-name', 'command-args']);
const INTERRUPTIONS = ['[Request interrupted by user', 'No response requested.'];
const CODEX_SKIPPED = [
  '<environment_context>', '# AGENTS.md instructions', '<turn_aborted>', 'Warning: apply_patch',
  '<user_instructions>', '<recommended_plugins>', '<external_',
];
const CODEX_IDE_CONTEXT = '# Context from my IDE setup:';
const CODEX_REQUESTS = new Set(['My request:', 'My request for Codex:']);
const LOCAL_OUTPUT = ['<local-command-stdout>', '<local-command-stderr>'];

const stripTags = (text) => {
  const cuts = [];
  let depth = 0;
  let from = 0;
  const parser = new Parser({
    onopentag(name) {
      if (DROPPED_TAGS.has(name)) {
        if (!depth) {
          from = parser.startIndex;
        }
        depth += 1;
      } else if (!depth && UNWRAPPED_TAGS.has(name)) {
        cuts.push([parser.startIndex, parser.endIndex + 1, '']);
      }
    },
    onclosetag(name, implied) {
      if (implied) {
        return;
      }
      if (DROPPED_TAGS.has(name)) {
        if (depth === 1) {
          cuts.push([from, parser.endIndex + 1, '']);
        } else if (!depth) {
          cuts.push([parser.startIndex, parser.endIndex + 1, '']);
        }
        depth = Math.max(0, depth - 1);
      } else if (!depth && UNWRAPPED_TAGS.has(name)) {
        cuts.push([parser.startIndex, parser.endIndex + 1, name === 'command-name' ? ' ' : '']);
      }
    },
  }, { decodeEntities: false, lowerCaseTags: true, lowerCaseAttributeNames: false });
  parser.end(text);
  if (depth) {
    cuts.push([from, text.length, '']);
  }
  let result = '';
  let at = 0;
  for (const [start, end, replacement] of cuts) {
    result += text.slice(at, start) + replacement;
    at = end;
  }
  return (result + text.slice(at)).trim();
};

const resolve = (session) => {
  if (existsSync(session) && statSync(session).isFile()) {
    return session;
  }
  const projects = join(homedir(), '.claude', 'projects');
  const codex = join(homedir(), '.codex', 'sessions');
  const found = (existsSync(projects) ? readdirSync(projects) : []).map((project) => join(projects, project, `${session}.jsonl`)).find(existsSync)
    ?? (existsSync(codex) ? readdirSync(codex, { recursive: true }).find((file) => file.endsWith(`${session}.jsonl`)) : undefined);
  if (!found) {
    fail(`no transcript for ${session}`);
  }
  return isAbsolute(found) ? found : join(codex, found);
};

const readLines = (path) => readFileSync(path, 'utf8').split('\n').flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});

function* readEvents(events) {
  const seen = new Set();
  for (const event of events) {
    const uuid = event.uuid ?? null;
    if (seen.has(uuid) || event.isSidechain) {
      continue;
    }
    seen.add(uuid);
    yield event;
  }
}

const promptText = (content) => {
  if (typeof content === 'string') {
    return stripTags(content);
  }
  const parts = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      return '';
    }
    if (block.type === 'text') {
      parts.push(stripTags(block.text));
    } else if (block.type === 'image') {
      parts.push('[image]');
    }
  }
  return parts.filter(Boolean).join('\n');
};

const isLocalOutput = (event) => {
  const { content } = event.message;
  const text = typeof content === 'string' ? content
    : content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
  return LOCAL_OUTPUT.some((prefix) => text.trimStart().startsWith(prefix));
};

const collectClaude = (events, path) => {
  const items = [];
  const answers = new Map();
  let cwd = '';
  for (const event of readEvents(events)) {
    cwd ||= event.cwd ?? '';
    if (event.type === 'user') {
      if (event.isMeta || event.isCompactSummary || event.sourceToolUseID) {
        continue;
      }
      if ((event.origin?.kind ?? 'human') !== 'human') {
        continue;
      }
      if (isLocalOutput(event)) {
        const last = items.at(-1);
        if (last?.kind === 'prompt' && last.value.startsWith('/')) {
          items.pop();
        }
        continue;
      }
      const text = promptText(event.message.content);
      if (text && !INTERRUPTIONS.some((prefix) => text.startsWith(prefix))) {
        items.push({ kind: 'prompt', time: event.timestamp, value: text, key: `${event.timestamp}\n${text}` });
      }
    } else if (event.type === 'attachment') {
      const { attachment } = event;
      if (attachment.type === 'queued_command' && attachment.commandMode === 'prompt') {
        const text = promptText(attachment.prompt || '');
        if (text) {
          items.push({ kind: 'prompt', time: event.timestamp, value: text, key: `${event.timestamp}\n${text}` });
        }
      }
    } else if (event.type === 'assistant') {
      const { message } = event;
      if (message.model === '<synthetic>') {
        continue;
      }
      let answer = answers.get(message.id);
      if (!answer) {
        answer = { text: [], tools: false, stop: null };
        answers.set(message.id, answer);
        items.push({ kind: 'answer', time: event.timestamp, value: answer, key: message.id });
      }
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          answer.tools = true;
        } else if (block.type === 'text' && block.text.trim()) {
          answer.text.push(block.text.trim());
        }
      }
      answer.stop = message.stop_reason || answer.stop;
    }
  }
  return { items, cwd, id: basename(path, '.jsonl').slice(0, 8) };
};

const codexRequest = (text) => {
  const tokens = lexer(text);
  const at = tokens.findIndex((token) => token.type === 'heading' && CODEX_REQUESTS.has(token.text.trim()));
  return at < 0 ? '' : tokens.slice(at + 1).map((token) => token.raw).join('');
};

const codexText = (text) => {
  if (text.startsWith(CODEX_IDE_CONTEXT)) {
    return codexRequest(text);
  }
  return CODEX_SKIPPED.some((prefix) => text.startsWith(prefix)) ? '' : text;
};

const codexPrompt = (payload) => {
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (kinds && !kinds.some((kind) => kind.startsWith('user.'))) {
    return '';
  }
  const parts = payload.content.map((item) => {
    if (item.type === 'input_image') {
      return '[image]';
    }
    return item.type === 'input_text' ? stripTags(decodeHTML(codexText(item.text))) : '';
  });
  return parts.filter(Boolean).join('\n');
};

const collectCodex = (events) => {
  const items = [];
  let cwd = '';
  let id = '';
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.type === 'session_meta' && payload.parent_thread_id) {
      break;
    }
    if (event.type === 'session_meta') {
      cwd ||= payload.cwd ?? '';
      id ||= payload.id ?? '';
    }
    if (event.type !== 'response_item' || payload.type !== 'message') {
      continue;
    }
    if (payload.role === 'user') {
      const text = codexPrompt(payload);
      if (text) {
        items.push({ kind: 'prompt', time: event.timestamp, value: text, key: `${event.timestamp}\n${text}` });
      }
    } else if (payload.role === 'assistant') {
      const text = payload.content.filter((item) => item.type === 'output_text').map((item) => item.text.trim()).filter(Boolean).join('\n\n');
      if (text) {
        const final = payload.phase === 'final_answer';
        const answer = { text: [text], tools: !final, stop: final ? payload.phase : null };
        items.push({ kind: 'answer', time: event.timestamp, value: answer, key: payload.id ?? `${event.timestamp}\n${text}` });
      }
    }
  }
  return { items, cwd, id: `codex ${id.slice(0, 8)}` };
};

const collect = (path) => {
  const events = readLines(path);
  return events[0]?.type === 'session_meta' ? collectCodex(events) : collectClaude(events, path);
};

const label = (items) => {
  const blocks = [];
  let afterF = true;
  let first = false;
  for (const { kind, time, value, key } of items) {
    if (kind === 'prompt') {
      blocks.push({ letter: afterF ? 'u' : 'g', time, text: value, key });
      afterF = false;
      first = true;
    } else if (!value.tools && value.text.length && value.stop) {
      blocks.push({ letter: 'f', time, text: value.text.join('\n\n'), key });
      afterF = true;
      first = false;
    } else if (first) {
      if (value.text.length) {
        blocks.push({ letter: 'a', time, text: value.text.join('\n\n'), key });
      }
      first = false;
    }
  }
  return blocks;
};

const UNWRAPPED = new Set(['link', 'strong', 'codespan']);

const render = (token) => {
  if (token.type === 'codespan') {
    return token.text;
  }
  return UNWRAPPED.has(token.type) ? token.tokens.map(render).join('') : token.raw;
};

const leading = (line) => line.length - line.trimStart().length;

const reindent = (code) => {
  const lines = code.split('\n').map((line) => line.replaceAll('\t', '    '));
  const widths = [...new Set(lines.filter((line) => line.trim()).map(leading))].sort((a, b) => a - b);
  return lines.map((line) => (line.trim() ? ' '.repeat(widths.indexOf(leading(line))) + line.trimStart() : '')).join('\n');
};

const renderCode = (token) => {
  const text = reindent(token.text);
  const trailing = token.raw.slice(token.raw.trimEnd().length);
  return token.codeBlockStyle === 'indented' ? text + trailing : token.raw.replace(token.text, () => text);
};

const squeeze = (line) => {
  const body = line.trimStart();
  return line.slice(0, line.length - body.length) + body.split(' ').filter(Boolean).join(' ');
};

const renderList = (list) => list.items.map((item) => {
  const content = item.tokens.map((token) => (token.type === 'list' ? renderList(token) : token.type === 'code' ? renderCode(token) : token.raw)).join('');
  const body = content.trimEnd().split('\n').map((line) => ` ${line}`);
  return body.join('\n') + item.raw.slice(item.raw.trimEnd().length);
}).join('');

const renderTable = (table) => [table.header, ...table.rows]
  .map((cells) => cells.map((cell) => cell.text).join(' | '))
  .join('\n') + table.raw.slice(table.raw.trimEnd().length);

const descendants = (token, into) => {
  for (const child of [...(token.tokens ?? []), ...(token.items ?? [])]) {
    into.add(child);
    descendants(child, into);
  }
};

const clean = (markdown) => {
  const unwrapped = [];
  const covered = new WeakSet();
  const listed = new WeakSet();
  walkTokens(lexer(markdown), (token) => {
    if (token.type === 'list' && !listed.has(token)) {
      unwrapped.push([token.raw, renderList(token)]);
      descendants(token, listed);
    }
    if (token.type === 'code' && !listed.has(token)) {
      unwrapped.push([token.raw, renderCode(token)]);
    }
    if (token.type === 'table' && !listed.has(token)) {
      unwrapped.push([token.raw, renderTable(token)]);
    }
    if (covered.has(token)) {
      token.tokens?.forEach((child) => covered.add(child));
    } else if (token.type === 'heading' && !listed.has(token)) {
      unwrapped.push([token.raw, token.tokens.map(render).join('') + token.raw.slice(token.raw.trimEnd().length)]);
      token.tokens.forEach((child) => covered.add(child));
    } else if (UNWRAPPED.has(token.type)) {
      unwrapped.push([token.raw, render(token)]);
      token.tokens?.forEach((child) => covered.add(child));
    }
  });
  unwrapped.sort((a, b) => b[0].length - a[0].length);
  const text = unwrapped.reduce((result, [raw, plainText]) => result.replaceAll(raw, () => plainText), markdown);
  return text.split('\n').filter((line) => line.trim()).map((line) => squeeze(line.trimEnd())).join('\n');
};

const relative = (text, root) => (root ? text.replaceAll(`${root}/`, './').replaceAll(root, '.') : text);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const main = () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    fail('usage: recall.mjs <transcript path or session id>...');
  }
  const sessions = args.map(resolve).map((path) => {
    const { items, cwd, id } = collect(path);
    return { path, cwd, id, blocks: label(items) };
  });
  sessions.sort((a, b) => compare(a.blocks[0]?.time ?? '', b.blocks[0]?.time ?? '') || compare(a.path, b.path));
  const seen = new Set();
  const sections = [];
  for (const { path, cwd, id, blocks } of sessions) {
    const fresh = blocks.map((block, index) => (seen.has(block.key) ? -1 : index)).filter((index) => index >= 0);
    blocks.forEach((block) => seen.add(block.key));
    if (!fresh.length) {
      continue;
    }
    let start = fresh[0];
    while (start > 0 && blocks[start].letter !== 'u') {
      start -= 1;
    }
    const kept = [...blocks.slice(start, fresh[0]), ...fresh.map((index) => blocks[index])];
    if (fresh.some((index) => blocks[index].letter === 'f')) {
      sections.push({ time: blocks[fresh[0]].time, path, cwd, id, kept });
    }
  }
  sections.sort((a, b) => compare(a.time, b.time) || compare(a.path, b.path));
  const out = [];
  for (const { cwd, id, kept } of sections) {
    out.push(`${out.length ? '\n' : ''}# ${id}\n`);
    let day = '';
    kept.forEach(({ letter, time, text }, index) => {
      const stamp = time.slice(0, 10) === day ? time.slice(11, 16) : `${time.slice(0, 10)} ${time.slice(11, 16)}`;
      day = time.slice(0, 10);
      out.push(`${index ? '\n' : ''}[${letter}] ${stamp}\n${relative(letter === 'f' || letter === 'a' ? clean(text) : reindent(clean(text)), cwd)}\n`);
    });
  }
  process.stdout.write(out.join(''));
};

main();
