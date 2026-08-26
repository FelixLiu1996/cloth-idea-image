import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "outputs", "uploads"]);

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path)));
    } else if (extname(entry.name) === ".md") {
      files.push(path);
    }
  }

  return files;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const markdownFiles = await collectMarkdownFiles(root);
const failures = [];
const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const file of markdownFiles) {
  const content = await readFile(file, "utf8");

  for (const match of content.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|#)/.test(rawTarget)) {
      continue;
    }

    const relativeTarget = decodeURIComponent(rawTarget.split("#", 1)[0]);
    const absoluteTarget = resolve(dirname(file), relativeTarget);
    if (!(await pathExists(absoluteTarget))) {
      failures.push(`${file}: ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  console.error("发现无效的本地文档链接：");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`文档链接检查通过：${markdownFiles.length} 个 Markdown 文件。`);
}
