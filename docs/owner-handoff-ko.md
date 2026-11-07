# Mini Planet 소유자 화면 인계

업무 보드, 프로필별 일정(`default`·`rodi`·`jarvis`), 로디 작업 요약을 보는
소유자 화면과 로그인 서버를 준비했습니다. **실제 Mac mini에는 아직 연결하지
않았습니다.** 가짜 로컬 컨트롤러로 인증과 API 경계를 테스트한 상태입니다.
첨부파일은 현재 컨트롤러 계약에서 제공하지 않습니다.

이 서버는 상태를 읽습니다. 업무를 실행하거나 Hermes·컨트롤러를 재시작하지
않으며, 자동 시작 서비스도 만들지 않습니다. 공개 Mini Planet 배포와는 별도로
사용합니다.

## 1. Mac mini의 기존 컨트롤러 확인

Mac mini 터미널에서 다음 **조회 명령만** 실행합니다.

```sh
cd /Users/rodiclawmini/.hermes/workspace/projects/mini-planet-controller
python3 ctl.py status
```

출력에서 현재 컨트롤러 포트를 확인합니다. 포트는 고정값으로 가정하지 않습니다.
보고서의 키 파일 위치는 이 폴더의 `.private/client-key`입니다. 키가 단일행인지,
파일 소유권·권한이 맞는지는 현장에서 확인해야 합니다. **키 내용을 터미널에
출력하거나 채팅·브라우저에 붙여넣지 마세요.**

## 2. 배포본과 로그인 비밀번호 준비

Python 3.10 이상을 사용합니다. 받은 번들의 `_site`, `owner-server.py`, `docs`를
같은 폴더에 둡니다. 아래 명령은 그 번들 폴더에서 실행합니다.

소스 저장소를 사용하는 경우에만 먼저 `node scripts/build-site.mjs`로 `_site`를
만들고, 실행 명령의 `owner-server.py`를 `scripts/owner-server.py`로 바꿉니다.
받은 번들에는 빌드 도구가 필요하지 않습니다.

업데이트할 때는 이 소유자 서버만 종료한 뒤 `_site`를 교체하고 다시 실행합니다.
실행 중인 서버는 시작할 때의 빌드 폴더를 유지하므로 폴더를 삭제·재생성한 뒤에는
소유자 서버 재실행이 필요합니다. Hermes나 기존 컨트롤러를 재시작할 필요는 없습니다.

로그인 비밀번호는 컨트롤러 키와 **다른 값**으로 준비합니다. 서버에 설치할
비공개 단일행 파일을 만들며 화면에 비밀번호를 출력하지 않습니다.

```sh
MP_PRIVATE_DIR="$HOME/.config/mini-planet-owner"
mkdir -p "$MP_PRIVATE_DIR"
chmod 700 "$MP_PRIVATE_DIR"
python3 - "$MP_PRIVATE_DIR/owner-password" <<'PY'
import getpass
import os
import sys

password = getpass.getpass('Mini Planet 로그인 비밀번호: ')
if not password or password != getpass.getpass('한 번 더 입력: '):
    raise SystemExit('비밀번호가 비어 있거나 일치하지 않습니다.')
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as stream:
    stream.write(password + '\n')
PY
```

이미 파일이 있으면 덮어쓰지 않고 중단합니다. 비밀번호와 컨트롤러 키 파일은
현재 사용자 소유의 일반 파일이고 권한이 `600` 또는 `400`이어야 합니다.
`_site` 안에 비밀 파일을 두거나 심볼릭 링크로 연결하지 않습니다.

## 3. 소유자 서버 실행

아래 첫 줄의 값을 **1단계에서 확인한 실제 포트**로 바꿉니다.

```sh
MP_CONTROLLER_PORT='확인한_컨트롤러_포트'
MP_CONTROLLER_KEY_FILE='/Users/rodiclawmini/.hermes/workspace/projects/mini-planet-controller/.private/client-key'
MP_OWNER_PORT=8787
python3 owner-server.py \
  --root "$PWD/_site" \
  --controller-url "http://127.0.0.1:$MP_CONTROLLER_PORT" \
  --controller-key-file "$MP_CONTROLLER_KEY_FILE" \
  --password-file "$MP_PRIVATE_DIR/owner-password" \
  --port "$MP_OWNER_PORT"
```

터미널에 표시된 `http://127.0.0.1:<소유자포트>/?owner=1`을 Mac mini 브라우저에서
열고 별도로 만든 로그인 비밀번호를 입력합니다. 컨트롤러 키는 서버가 파일에서
읽습니다. 오류나 오래된 데이터는 오류·지연 상태로 표시하며 정상으로 추정하지
않습니다. 종료는 이 터미널에서 `Ctrl+C`이며 기존 Hermes는 계속 동작합니다.

## 4. 다른 기기에서 확인

서버는 Mac mini의 loopback에만 열립니다. 다른 기기에서는 SSH 터널이나 비공개
HTTPS 프록시를 구성한 뒤 **로그인·업무·일정·로디 요약·로그아웃을 실제로
검증해야 합니다.** 이 검증은 아직 수행하지 않았습니다.

SSH를 쓴다면 다른 기기 터미널에서 같은 소유자 포트를 양쪽에 사용합니다.

```sh
MP_OWNER_PORT=8787
ssh -N -L "127.0.0.1:$MP_OWNER_PORT:127.0.0.1:$MP_OWNER_PORT" MAC_MINI_SSH_ALIAS
```

그 기기의 브라우저에서 `http://127.0.0.1:8787/?owner=1`을 엽니다. 포트를 바꿨다면
URL도 함께 바꿉니다. 비공개 HTTPS 프록시는 `--public-origin` 설정과 정확한
Host·Origin 전달이 필요합니다. 상세 설정과 API 계약은
[owner-hosting.md](owner-hosting.md)에 있습니다.
