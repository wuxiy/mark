import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, posix } from 'node:path';

const MAX_GIT_OUTPUT = 24 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DOCUMENTS = 2_000;

export interface TreeFile {
  path: string;
  oid: string;
  mode: string;
}

export interface IndexedDocument extends TreeFile {
  title: string;
  body: string;
  hash: string;
}

export async function git(args: string[], cwd?: string, maxBytes = MAX_GIT_OUTPUT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'http.followRedirects=false', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
      signal: AbortSignal.timeout(90_000),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > maxBytes) child.kill();
      else stdout.push(part);
    });
    child.stderr.on('data', (part: Buffer) => {
      if (Buffer.concat(stderr).length < 8_192) stderr.push(part);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && size <= maxBytes) resolve(Buffer.concat(stdout));
      else reject(new Error(size > maxBytes ? 'Git 输出超过限制' : Buffer.concat(stderr).toString('utf8').trim() || 'Git 操作失败'));
    });
  });
}

export function normalizeGitHubUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('请输入公开 GitHub 仓库的 HTTPS 地址');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('只支持 github.com 的公开 HTTPS 仓库地址');
  }
  const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !/^[A-Za-z0-9-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) {
    throw new Error('仓库地址应为 https://github.com/所有者/仓库');
  }
  const repo = parts[1].replace(/\.git$/i, '');
  if (repo === '.' || repo === '..' || !repo) throw new Error('仓库名称无效');
  return `https://github.com/${parts[0]}/${repo}.git`;
}

export async function previewGitHubSource(input: string): Promise<{ url: string; name: string; branch: string }> {
  const url = normalizeGitHubUrl(input);
  const output = (await git(['ls-remote', '--symref', url, 'HEAD'], undefined, 32_768)).toString('utf8');
  const branch = output.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1];
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new Error('无法读取仓库默认分支；请确认仓库公开且可访问');
  }
  return { url, name: basename(url, '.git'), branch };
}

export function mirrorPath(dataDir: string, sourceId: number): string {
  return join(dataDir, 'repos', `${sourceId}.git`);
}

export async function fetchSource(dataDir: string, sourceId: number, url: string, branch: string): Promise<{ repo: string; sha: string }> {
  const repo = mirrorPath(dataDir, sourceId);
  let fresh = false;
  if (!existsSync(repo)) {
    mkdirSync(join(dataDir, 'repos'), { recursive: true });
    const temporary = `${repo}.importing`;
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    try {
      await git(['clone', '--bare', '--single-branch', '--depth=1', '--branch', branch, url, temporary]);
      renameSync(temporary, repo);
      fresh = true;
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  } else {
    // Keep protected historical commits while fetching from the current configured URL.
    await git(['-C', repo, 'remote', 'set-url', 'origin', url]);
    await git(['-C', repo, 'fetch', '--no-tags', 'origin', branch]);
  }
  const sha = (await git(['-C', repo, 'rev-parse', fresh ? `refs/heads/${branch}` : 'FETCH_HEAD'])).toString('utf8').trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('无法识别上游版本');
  await git(['-C', repo, 'update-ref', `refs/mark/published/${sha}`, sha]);
  return { repo, sha };
}

export async function listMarkdown(repo: string, sha: string): Promise<TreeFile[]> {
  const output = (await git(['-C', repo, 'ls-tree', '-r', '-z', sha])).toString('utf8');
  const files = output.split('\0').filter(Boolean).flatMap((entry) => {
    const match = entry.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/s);
    if (!match || !['100644', '100755'].includes(match[1]) || !/\.md(?:own)?$/i.test(match[3])) return [];
    return [{ mode: match[1], oid: match[2], path: match[3] }];
  });
  if (files.length > MAX_DOCUMENTS) throw new Error(`Markdown 文档超过 ${MAX_DOCUMENTS} 个，已停止导入`);
  return files;
}

export async function readTreeFile(repo: string, sha: string, path: string, limit = MAX_DOCUMENT_BYTES): Promise<Buffer> {
  if (!safeTreePath(path)) throw new Error('文档路径无效');
  const size = Number((await git(['-C', repo, 'cat-file', '-s', `${sha}:${path}`], undefined, 100)).toString('utf8').trim());
  if (!Number.isSafeInteger(size) || size > limit) throw new Error('文件超过读取限制');
  return git(['-C', repo, 'show', `${sha}:${path}`], undefined, limit);
}

export function safeTreePath(value: string): boolean {
  return Boolean(value && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..') && posix.normalize(value) === value);
}

export async function readAsset(repo: string, sha: string, path: string): Promise<Buffer> {
  if (!safeTreePath(path)) throw new Error('资源路径无效');
  const tree = (await git(['-C', repo, 'ls-tree', sha, '--', path], undefined, 1_024)).toString('utf8');
  if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(tree)) throw new Error('资源不存在或类型不受支持');
  return readTreeFile(repo, sha, path, 4 * 1024 * 1024);
}

export function summarizeMarkdown(markdown: string, path: string): { title: string; body: string; hash: string } {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = heading || posix.basename(path).replace(/\.md(?:own)?$/i, '');
  const body = markdown
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#>*`_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, body, hash: createHash('sha256').update(markdown).digest('hex') };
}
