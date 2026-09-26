# Mac mini F키 업데이트 적용 안내

**2026-09-26: 업데이트 준비용 안내이며, Mac mini 배포판에는 아직 적용하지 않았습니다.**
인증된 원격 접속으로 설치·동작을 확인한 기록도 없습니다. 아래 절차는 Hermes가
실제 Mac mini에서 수행하고 결과를 확인하기 위한 것입니다.

전달 파일은 `mini-planet-f-key-update-20260926.zip`입니다. 기존 배포 폴더의
다음 네 파일만 교체합니다. `src/nearby-interaction.js`는 새로 추가되는 파일입니다.

```text
_site/index.html
_site/src/main.js
_site/src/nearby-interaction.js
_site/sw.js
```

`owner-server.py`, 기존 비밀번호, 컨트롤러 구성은 변경하지 않습니다.
Hermes·Gateway·컨트롤러는 재시작하지 않습니다. 소유자 서버 재시작으로 기존
브라우저 로그인 세션이 만료되므로 기존 비밀번호로 다시 로그인합니다.

## 1. 압축 해제와 무결성 확인

ZIP을 Mac mini에 받은 뒤 다음을 실행합니다. 다운로드 위치가 다르면 ZIP 경로만
실제 위치로 바꿉니다. 배포 폴더에 바로 압축을 풀지 않습니다.

```sh
MP_OWNER_DIR='/Users/rodiclawmini/.hermes/workspace/projects/mini-planet-owner-20260925/mini-planet-owner'
MP_OWNER_CTL="$HOME/.config/mini-planet-owner/ownerctl.py"
MP_OWNER_PY='/Users/rodiclawmini/.hermes/hermes-agent/venv/bin/python'
MP_UPDATE_ZIP="$HOME/Downloads/mini-planet-f-key-update-20260926.zip"
MP_UPDATE_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mini-planet-f-key.XXXXXX")"
unzip -q "$MP_UPDATE_ZIP" -d "$MP_UPDATE_STAGE"
(cd "$MP_UPDATE_STAGE" && shasum -a 256 -c SHA256SUMS)
```

`SHA256SUMS`는 위 네 `_site/` 경로를 검사해야 합니다. 네 파일 모두 `OK`인지
확인하고, 누락·불일치·예상하지 않은 교체 경로가 있으면 적용을 중단합니다.
ZIP 자체의 SHA-256도 별도로 전달받았다면 그 값과 함께 대조합니다.

## 2. 기존 네 경로 백업

```sh
MP_UPDATE_BACKUP="$(mktemp -d "$MP_OWNER_DIR/f-key-backup-20260926.XXXXXX")"
for MP_REL in _site/index.html _site/src/main.js _site/src/nearby-interaction.js _site/sw.js; do
  if [ -f "$MP_OWNER_DIR/$MP_REL" ]; then
    mkdir -p "$MP_UPDATE_BACKUP/$(dirname "$MP_REL")"
    cp -p "$MP_OWNER_DIR/$MP_REL" "$MP_UPDATE_BACKUP/$MP_REL"
  else
    printf '%s\n' "$MP_REL" >> "$MP_UPDATE_BACKUP/absent-before.txt"
  fi
done
```

백업 파일을 확인합니다. 기존에 없을 수 있는 경로는 신규 파일인
`_site/src/nearby-interaction.js`뿐입니다. 다른 파일도 없다면 배포 위치부터
재확인합니다. 백업 폴더 위치를 적용 결과에 기록합니다.

## 3. 소유자 서버 중지 → 네 파일 복사 → 재시작

아래 블록은 명령 하나라도 실패하면 중단합니다. 실패한 채 다음 단계로 진행하지
말고 백업 복구 절차를 따릅니다.

```sh
(
  set -eu
  "$MP_OWNER_PY" "$MP_OWNER_CTL" stop
  for MP_REL in _site/index.html _site/src/main.js _site/src/nearby-interaction.js _site/sw.js; do
    cp -p "$MP_UPDATE_STAGE/$MP_REL" "$MP_OWNER_DIR/$MP_REL"
  done
  cd "$MP_OWNER_DIR"
  shasum -a 256 -c "$MP_UPDATE_STAGE/SHA256SUMS"
  "$MP_OWNER_PY" "$MP_OWNER_CTL" start
)
```

복사된 네 파일의 해시가 모두 `OK`여야 합니다. 시작 출력과 실제 리스닝 정보를
대조해 **현재 소유자 서버 포트**를 다시 확인합니다. 이전 포트나 컨트롤러 포트를
소유자 서버 포트로 가정하지 않습니다.

## 4. HTTP 및 화면 확인

확인한 포트로 아래의 값을 바꾸고 네 URL이 각각 **HTTP 200**인지 확인합니다.

```sh
MP_OWNER_PORT='확인한_소유자_서버_포트'
for MP_URL_PATH in /index.html /src/main.js /src/nearby-interaction.js /sw.js; do
  curl --silent --show-error --fail --output /dev/null --write-out '%{http_code}\n' \
    "http://127.0.0.1:$MP_OWNER_PORT$MP_URL_PATH"
done
```

기존 서버가 `--public-origin`을 쓰고 있다면 기존 비공개 HTTPS 주소로 검사하거나,
로컬 검사에 그 주소의 정확한 `Host`를 전달합니다. 403을 피하려고 서버 설정을
바꾸지 않습니다. HTTP 200만으로 화면 검증까지 완료되었다고 판단하지 않습니다.

브라우저에서 기존 소유자 주소를 열고 새로고침한 뒤 다음을 확인합니다.

1. 기존 비밀번호로 로그인하고 **산책 모드**로 들어갑니다.
2. 주민 가까이에서 주민 이름과 `F 말 걸기` 안내가 나타나는지 확인합니다.
   F를 누르면 해당 주민 화면이 열리고, 닫으면 산책을 계속할 수 있어야 합니다.
3. 한글 입력 상태에서도 같은 물리 키인 **ㄹ**로 동일하게 열리는지 확인합니다.
   입력란에 글을 쓰는 동안에는 주민 화면이 갑자기 열리지 않아야 합니다.
4. 주민에게서 떨어진 집 문 앞에서 `F 입장`과 집 화면을 확인합니다.
   배 근처에서는 `F 승선`, 승선 후에는 `F 하선`을 확인합니다.
5. 주민·집·배가 가까이 겹치면 화면에 표시된 대상과 실제 열린 대상이 일치하는지
   확인합니다. 배 이용이 먼저이며, 그다음 주민, 집 순서입니다.

이상 시 새로고침 후 재확인하고, 콘솔 오류나 신규 모듈의 404 여부를 기록합니다.
실제 적용 보고에는 백업 위치, 네 파일 해시 결과, 현재 포트, 네 HTTP 상태,
F·ㄹ·집·배 검증 결과를 적습니다. 비밀번호와 인증키는 기록하지 않습니다.

## 개발 환경에서 확인한 결과

- Node 테스트 354개 통과: 근접 거리, 가장 가까운 주민, 배·주민·집 우선순위,
  이동한 주민 재선택, 입력창·열린 패널에서의 차단, 기존 집·배 동작 포함.
- 배포 전 검사와 정적 배포본 99개 파일 검증 통과.
- 실제 브라우저: F로 로디 공개 카드 열기, owner 모드에서 F → 로그인 → 로디 업무
  필터, 열린 작업실에서 F를 눌러도 다른 주민 필터 유지, 모바일 말 걸기 버튼 확인.
- owner 화면 검증에는 익명화된 응답을 사용하는 별도 로컬 미리보기를 사용했습니다.
  Mac mini의 실제 배포 확인은 위 절차로 별도로 수행합니다.

## 실패 시 복구

`"$MP_OWNER_PY" "$MP_OWNER_CTL" stop`으로 소유자 서버만 중지합니다. 백업에 있는 파일을
동일한 `_site/` 경로로 복원하고, `absent-before.txt`에 기록된 신규 파일만 제거합니다.
`"$MP_OWNER_PY" "$MP_OWNER_CTL" start` 후 현재 포트와 HTTP 상태를 다시 확인합니다.
전체 `_site`를 삭제하거나 서버·인증·컨트롤러 설정을 되돌릴 필요는 없습니다.
