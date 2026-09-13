#!/usr/bin/env bash
#
# sync-claude.sh —— 把共享的 Claude Code 配置同步进当前项目的 .claude/
#
#   规范源：https://github.com/czwan/czClaudeWorkflow
#   在“消费方”项目根目录运行。同步产物应当提交进 git ——
#   云端/手机会话只读 repo 里提交的 .claude/，读不到你笔记本的 ~/.claude/。
#
# 用法：
#   ./sync-claude.sh                 同步默认分支
#   ./sync-claude.sh --ref v1.2.0    钉一个 tag / 分支 / commit
#   ./sync-claude.sh --dry-run       只看会改什么
#   ./sync-claude.sh --check         有差异就退出码 1（给 CI 用）
#   ./sync-claude.sh --with-settings 连 settings.json 一起同步（默认不同步）
#
# 源仓库是私有的：本地跑靠你机器上的 git/gh 凭据；CI 里没有 ambient 凭据，
# 设置 CLAUDE_SYNC_TOKEN（一个只读 czClaudeWorkflow 的 PAT）即可鉴权 clone。
#
set -euo pipefail

SOURCE_REPO="${CLAUDE_SYNC_SOURCE:-https://github.com/czwan/czClaudeWorkflow.git}"
REF=""
DRY_RUN=0
CHECK=0
WITH_SETTINGS=0

# 会被同步的子目录。settings.json 单独处理，见 --with-settings
SYNC_DIRS=(workflows skills agents commands rules hooks)

# 永不同步：项目上下文和本地私有配置
NEVER=(CLAUDE.md settings.local.json README.md .git .github)

DEST=".claude"
MANIFEST="$DEST/.synced-files"
REFFILE="$DEST/.synced-ref"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m•\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)           REF="${2:-}"; [ -n "$REF" ] || die "--ref 需要一个值"; shift 2 ;;
    --source)        SOURCE_REPO="${2:-}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --check)         CHECK=1; DRY_RUN=1; shift ;;
    --with-settings) WITH_SETTINGS=1; shift ;;
    -h|--help)       sed -n '2,20p' "$0"; exit 0 ;;
    *)               die "未知参数：$1" ;;
  esac
done

command -v git >/dev/null || die "需要 git"
# 用 rev-parse 而不是 [ -d .git ]：git worktree 里的 .git 是文件不是目录，
# 而 Claude Code 的会话正是跑在 worktree 里的。
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "请在 git 仓库内运行"
[ "$ROOT" = "$PWD" ] || die "请在项目根目录运行（当前：$PWD，根目录：$ROOT）"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 实际拿去 clone 的 URL：故意不直接改 SOURCE_REPO 本身——那个变量会被打印到
# 下面的日志、写进 .synced-ref 并提交进仓库，混入 token 等于把凭据泄露进 commit 历史。
CLONE_URL="$SOURCE_REPO"
if [ -n "${CLAUDE_SYNC_TOKEN:-}" ]; then
  case "$SOURCE_REPO" in
    https://github.com/*)
      CLONE_URL="https://x-access-token:${CLAUDE_SYNC_TOKEN}@github.com/${SOURCE_REPO#https://github.com/}"
      ;;
  esac
fi

info "拉取 $SOURCE_REPO ${REF:+($REF)}"
if [ -n "$REF" ]; then
  git clone --quiet --depth 1 --branch "$REF" "$CLONE_URL" "$TMP/src" 2>/dev/null \
    || { git clone --quiet "$CLONE_URL" "$TMP/src"
         git -C "$TMP/src" checkout --quiet "$REF" || die "找不到 ref: $REF"; }
else
  git clone --quiet --depth 1 "$CLONE_URL" "$TMP/src"
fi

SHA="$(git -C "$TMP/src" rev-parse HEAD)"

# ---- 布局探测：.claude/ 在根目录，还是 skills/ 直接在根目录 ----
if [ -d "$TMP/src/.claude" ]; then
  SRC="$TMP/src/.claude"
else
  SRC="$TMP/src"
fi

FOUND=0
for d in "${SYNC_DIRS[@]}"; do [ -d "$SRC/$d" ] && FOUND=1; done
[ "$FOUND" = "1" ] || die "在源仓库里没找到任何 ${SYNC_DIRS[*]} 目录（探测路径：${SRC#$TMP/src/})"

# ---- 收集源文件清单（相对 .claude/ 的路径）----
NEWLIST="$TMP/new"
: > "$NEWLIST"
for d in "${SYNC_DIRS[@]}"; do
  [ -d "$SRC/$d" ] || continue
  ( cd "$SRC" && find "$d" -type f ! -name '.DS_Store' -print ) >> "$NEWLIST"
done
if [ "$WITH_SETTINGS" = "1" ] && [ -f "$SRC/settings.json" ]; then
  echo "settings.json" >> "$NEWLIST"
fi

# 过滤永不同步项
for n in "${NEVER[@]}"; do
  grep -v -x -e "$n" -e "$n/.*" "$NEWLIST" > "$NEWLIST.f" 2>/dev/null || : > "$NEWLIST.f"
  mv "$NEWLIST.f" "$NEWLIST"
done
LC_ALL=C sort -o "$NEWLIST" "$NEWLIST"

# ---- 上次同步的清单：只有它列出的文件才允许被删 ----
OLDLIST="$TMP/old"
if [ -f "$MANIFEST" ]; then grep -v '^#' "$MANIFEST" | grep -v '^$' | LC_ALL=C sort > "$OLDLIST"; else : > "$OLDLIST"; fi

ADDED=""; CHANGED=""; REMOVED=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ ! -f "$DEST/$f" ]; then ADDED="$ADDED$f"$'\n'
  elif ! cmp -s "$SRC/$f" "$DEST/$f"; then CHANGED="$CHANGED$f"$'\n'
  fi
done < "$NEWLIST"
# 上次同步过、这次源里没有了 → 上游删除，同步删除。项目自建的文件不在清单里，不受影响。
REMOVED="$(LC_ALL=C comm -23 "$OLDLIST" "$NEWLIST" || true)"

n_add=$(printf '%s' "$ADDED"   | grep -c . || true)
n_chg=$(printf '%s' "$CHANGED" | grep -c . || true)
n_del=$(printf '%s' "$REMOVED" | grep -c . || true)

printf '\n'
[ "$n_add" -gt 0 ] && printf '%s' "$ADDED"   | sed 's/^/  + /'
[ "$n_chg" -gt 0 ] && printf '%s' "$CHANGED" | sed 's/^/  ~ /'
[ "$n_del" -gt 0 ] && printf '%s' "$REMOVED" | sed 's/^/  - /'
if [ $((n_add + n_chg + n_del)) -eq 0 ]; then
  info "已是最新（$(echo "$SHA" | cut -c1-7)）"
  exit 0
fi
printf '\n'
info "新增 $n_add · 更新 $n_chg · 删除 $n_del"

if [ "$CHECK" = "1" ]; then
  info "--check：与 $(echo "$SHA" | cut -c1-7) 存在差异"
  exit 1
fi
if [ "$DRY_RUN" = "1" ]; then
  info "--dry-run：未改动任何文件"
  exit 0
fi

# ---- 应用 ----
printf '%s\n' "$REMOVED" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  rm -f "$DEST/$f"
  d="$(dirname "$DEST/$f")"
  while [ "$d" != "$DEST" ] && [ -d "$d" ]; do rmdir "$d" 2>/dev/null || break; d="$(dirname "$d")"; done
done

while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$SRC/$f" "$DEST/$f"
done < "$NEWLIST"

{
  echo "# 由 sync-claude.sh 生成 —— 请勿手工编辑这里列出的文件，改动会在下次同步时被覆盖。"
  echo "# 源：$SOURCE_REPO @ $SHA"
  cat "$NEWLIST"
} > "$MANIFEST"

{
  echo "source=$SOURCE_REPO"
  echo "ref=${REF:-default}"
  echo "commit=$SHA"
  echo "synced_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$REFFILE"

info "已同步到 $(echo "$SHA" | cut -c1-7)"
info "记得把 $DEST 一起提交 —— 云端和手机会话只读仓库里的版本"
