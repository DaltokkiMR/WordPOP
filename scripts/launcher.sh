#!/bin/bash
# WordPOP.app이 호출하는 서버 시작·종료 도우미
#   launcher.sh start       → "<PID> <주소>" 출력 (이미 다른 곳에서 켠 서버면 PID 자리에 "-")
#   launcher.sh stop <PID>  → 이 앱이 켠 서버만 종료
#   launcher.sh alive <PID> → 서버가 살아 있으면 0
set -u

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
port="${PORT:-3000}"
url="http://127.0.0.1:${port}"
log_dir="$HOME/Library/Logs/WordPOP"
log_file="$log_dir/server.log"
pid_file="$log_dir/server.pid"

fail() { printf '%s\n' "$*" >&2; exit 1; }

# Finder에서 연 앱은 터미널의 PATH를 모르므로 로그인 셸에서 가져온다 (node·codex 탐색용).
load_path() {
  local shell="${SHELL:-/bin/zsh}" login_path
  login_path="$("$shell" -lc 'printf %s "$PATH"' </dev/null 2>/dev/null)"
  [ -n "$login_path" ] && export PATH="$login_path:$PATH"
  # nvm처럼 .zshrc에서만 설정하는 경우를 위해 대화형 셸도 확인한다.
  if ! command -v node >/dev/null 2>&1; then
    login_path="$("$shell" -lic 'printf "\n%s" "$PATH"' </dev/null 2>/dev/null | tail -n 1)"
    [ -n "$login_path" ] && export PATH="$login_path:$PATH"
  fi
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin"
}

is_wordpop() { curl -fsS --max-time 1 "$url/" 2>/dev/null | grep -q '<title>WordPOP'; }
is_our_server() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q 'server\.mjs'; }

start() {
  mkdir -p "$log_dir"
  if is_wordpop; then
    local previous
    previous="$(cat "$pid_file" 2>/dev/null)"
    # 이전에 앱이 켜 둔 서버가 남아 있으면 이어받고, 터미널에서 직접 켠 서버는 건드리지 않는다.
    if is_our_server "$previous"; then echo "$previous $url"; else echo "- $url"; fi
    return
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    fail "${port}번 포트를 다른 프로그램이 사용 중입니다. 저장된 학습은 이 주소에 연결되어 있으므로 해당 프로그램을 종료한 뒤 다시 열어 주세요."
  fi

  load_path
  command -v node >/dev/null 2>&1 || fail "Node.js를 찾지 못했습니다. Node.js 22.12 이상을 설치해 주세요."
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
    || fail "Node.js $(node -v)은 지원하지 않습니다. 22.12 이상으로 업데이트해 주세요."

  cd "$project_dir" || fail "프로젝트 폴더를 찾지 못했습니다: $project_dir"
  if [ ! -d node_modules ]; then
    npm install --no-audit --no-fund >"$log_file" 2>&1 || fail "npm install에 실패했습니다. 로그: $log_file"
  fi

  PORT="$port" nohup node server.mjs >"$log_file" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" >"$pid_file"
  for _ in $(seq 50); do
    if is_wordpop; then echo "$pid $url"; return; fi
    kill -0 "$pid" 2>/dev/null || fail "서버가 시작 직후 종료되었습니다.
$(tail -n 5 "$log_file")"
    sleep 0.2
  done
  kill "$pid" 2>/dev/null
  fail "서버가 10초 안에 응답하지 않았습니다. 로그: $log_file"
}

stop() {
  local pid="${1:-}"
  is_our_server "$pid" || return 0
  kill "$pid" 2>/dev/null
  for _ in $(seq 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  rm -f "$pid_file"
}

case "${1:-}" in
  start) start ;;
  stop) stop "${2:-}" ;;
  alive) kill -0 "${2:-x}" 2>/dev/null ;;
  *) fail "사용법: launcher.sh start | stop <PID> | alive <PID>" ;;
esac
