/**
 * 命令审批策略:危险模式检测、命令签名提取、展示格式化。
 *
 * 语义逐条对齐 Python 版 deepagents_acp/utils.py——approve_always 的
 * 「同类命令自动放行」必须与旧 agent 行为一致,否则 e2e/联调里用户
 * 拍过的命令类别会重新弹窗。
 */

/** 指示 shell 注入风险的字面子串:重定向、替换、控制字符等。 */
const DANGEROUS_SHELL_PATTERNS = [
  '$(', // 命令替换
  '`', // 反引号命令替换
  "$'", // ANSI-C 引号(可经转义序列编码危险字符)
  '\n', // 换行(命令注入)
  '\r', // 回车(命令注入)
  '\t', // 制表符(某些 shell 里可注入)
  '<(', // 进程替换(输入)
  '>(', // 进程替换(输出)
  '<<<', // here-string
  '<<', // here-doc(可内嵌命令)
  '>>', // 追加重定向
  '>', // 输出重定向
  '<', // 输入重定向
  '${', // 花括号变量展开(${var:-$(cmd)} 可执行命令)
];

/** 命令是否包含危险 shell 模式(即使基础命令在允许清单里也拒绝自动放行)。 */
export function containsDangerousPatterns(command: string): boolean {
  if (DANGEROUS_SHELL_PATTERNS.some((pattern) => command.includes(pattern))) {
    return true;
  }
  // 裸变量展开($VAR 不带花括号)可泄漏敏感路径;${ 和 $( 上面已挡,
  // 这里兜住 $HOME、$IFS 之类。
  if (/\$[A-Za-z_]/.test(command)) {
    return true;
  }
  // 独立的 &(后台执行)不应自动放行;排除 && 里的 &。
  return /(?<!&)&(?!&)/.test(command);
}

/** 按空白切分命令(尊重单双引号),解析失败返回 null。 */
function shellSplit(segment: string): string[] | null {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        token += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += ch;
    }
  }
  if (quote) {
    return null; // 未闭合引号,交给调用方跳过
  }
  if (token) {
    tokens.push(token);
  }
  return tokens;
}

/** 敏感命令的签名提取:python/node/npm/npx/yarn/pnpm/uv。 */
function extractSignature(tokens: string[]): string {
  const base = tokens[0]!;
  const second = tokens[1];
  switch (base) {
    case 'python':
    case 'python3':
      // python -m <module> → 带模块;python -c → 只带 flag;脚本 → 只带基名
      if (second === '-m' && tokens.length > 2) return `${base} -m ${tokens[2]}`;
      if (second === '-c') return `${base} -c`;
      return base;
    case 'node':
      if (second === '-e' || second === '-p') return `${base} ${second}`;
      return base;
    case 'npx':
      // npx <package> 永远带包名(任意包可执行任意代码)
      return tokens.length > 1 ? `${base} ${second}` : base;
    case 'npm':
    case 'yarn':
    case 'pnpm':
      // run <script> 带脚本名;其余带子命令
      if (second === 'run' && tokens.length > 2) return `${base} run ${tokens[2]}`;
      return second ? `${base} ${second}` : base;
    case 'uv':
      if (second === 'run' && tokens.length > 2) return `${base} run ${tokens[2]}`;
      return second ? `${base} ${second}` : base;
    default:
      return base;
  }
}

const SENSITIVE_COMMANDS = new Set(['python', 'python3', 'node', 'npm', 'npx', 'yarn', 'pnpm', 'uv']);

/**
 * 提取命令里所有命令签名(按 &&、||、;、| 分段,敏感命令带签名),
 * 用于 approve_always 的同类命令记忆。解析失败的分段跳过。
 */
export function extractCommandTypes(command: string): string[] {
  if (!command.trim()) {
    return [];
  }
  const commandTypes: string[] = [];
  const compoundSegments = command.split(/&&|\|\||;/);
  for (const rawSegment of compoundSegments) {
    const segment = rawSegment.trim();
    if (!segment) {
      continue;
    }
    for (const rawPipeSegment of segment.split('|')) {
      const pipeSegment = rawPipeSegment.trim();
      if (!pipeSegment) {
        continue;
      }
      const tokens = shellSplit(pipeSegment);
      if (!tokens || tokens.length === 0) {
        continue;
      }
      const base = tokens[0]!;
      commandTypes.push(SENSITIVE_COMMANDS.has(base) ? extractSignature(tokens) : base);
    }
  }
  return commandTypes;
}

const MAX_DISPLAY_COMMAND_LENGTH = 120;

/** 截断命令字符串用于权限卡展示。 */
export function truncateExecuteCommandForDisplay(command: string): string {
  if (command.length >= MAX_DISPLAY_COMMAND_LENGTH) {
    return command.slice(0, MAX_DISPLAY_COMMAND_LENGTH) + '...';
  }
  return command;
}

/** 把 execute 工具结果格式化为「命令/输出/状态」的 Markdown 展示。 */
export function formatExecuteResult(command: string, result: string): string {
  const lines = result.split('\n');
  const outputLines: string[] = [];
  let exitCodeLine: string | null = null;
  let truncatedLine: string | null = null;
  for (const line of lines) {
    if (line.startsWith('[Command ') && line.includes('exit code')) {
      exitCodeLine = line;
    } else if (line.startsWith('[Output was truncated')) {
      truncatedLine = line;
    } else {
      outputLines.push(line);
    }
  }
  const output = outputLines.join('\n').replace(/\s+$/, '');

  const parts: string[] = [];
  parts.push(`**Command:**\n\`\`\`bash\n${command}\n\`\`\`\n`);
  if (output) {
    parts.push(`**Output:**\n\`\`\`\n${output}\n\`\`\`\n`);
  } else {
    parts.push('**Output:** _(empty)_\n');
  }
  if (exitCodeLine) {
    parts.push(`**Status:** ${exitCodeLine.replace(/^\[|\]$/g, '')}`);
  }
  if (truncatedLine) {
    parts.push(`\n_${truncatedLine.replace(/^\[|\]$/g, '')}_`);
  }
  return parts.join('\n');
}
