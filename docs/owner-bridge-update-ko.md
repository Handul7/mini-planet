# Mac mini 보행교·F키 누적 업데이트

**2026-09-26: Mac mini 배포판에는 아직 반영하지 않았습니다.** 아래는 Hermes가
Mac mini에서 적용하고 확인할 절차입니다. 실제 원격 적용·검증 결과가 아닙니다.

`mini-planet-bridge-and-f-key-20260926.zip`은 남쪽 섬과 율의 집이 있는 마을을
연결하는 보행교와 주민 F키 상호작용을 함께 담은 누적 업데이트입니다.
이전 F키 ZIP을 적용하지 않았어도 **이 ZIP 하나만 적용하면 됩니다.**

교체 대상은 다음 다섯 파일뿐입니다.

```text
_site/index.html
_site/src/main.js
_site/src/nearby-interaction.js
_site/src/world/footbridge.js
_site/sw.js
```

`owner-server.py`, 비밀번호, 컨트롤러 구성은 변경하지 않습니다. 소유자 서버만
중지·시작하며 Hermes·Gateway·컨트롤러는 재시작하지 않습니다. 소유자 서버를
재시작하면 기존 로그인 세션이 만료되므로 같은 비밀번호로 다시 로그인합니다.

## 1. 압축 해제·해시 확인

받은 ZIP의 위치가 다르면 아래 다운로드 경로만 바꿉니다. 배포 폴더에 바로
압축을 풀지 않습니다.

```sh
MP_OWNER_DIR='/Users/rodiclawmini/.hermes/workspace/projects/mini-planet-owner-20260925/mini-planet-owner'
MP_OWNER_CTL="$HOME/.config/mini-planet-owner/ownerctl.py"
MP_OWNER_PY='/Users/rodiclawmini/.hermes/hermes-agent/venv/bin/python'
MP_UPDATE_ZIP="$HOME/Downloads/mini-planet-bridge-and-f-key-20260926.zip"
MP_UPDATE_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mini-planet-bridge.XXXXXX")"
unzip -q "$MP_UPDATE_ZIP" -d "$MP_UPDATE_STAGE"
(cd "$MP_UPDATE_STAGE" && shasum -a 256 -c SHA256SUMS)
```

`SHA256SUMS`에 위 다섯 `_site/` 경로가 있고 모두 `OK`인지 확인합니다.
불일치·누락·예상하지 않은 교체 경로가 있으면 중단합니다. ZIP 자체의 SHA-256도
별도 전달받았다면 대조합니다.

## 2. 기존 다섯 경로 백업

```sh
MP_UPDATE_BACKUP="$(mktemp -d "$MP_OWNER_DIR/bridge-backup-20260926.XXXXXX")"
for MP_REL in _site/index.html _site/src/main.js _site/src/nearby-interaction.js _site/src/world/footbridge.js _site/sw.js; do
  if [ -f "$MP_OWNER_DIR/$MP_REL" ]; then
    mkdir -p "$MP_UPDATE_BACKUP/$(dirname "$MP_REL")"
    cp -p "$MP_OWNER_DIR/$MP_REL" "$MP_UPDATE_BACKUP/$MP_REL"
  else
    printf '%s\n' "$MP_REL" >> "$MP_UPDATE_BACKUP/absent-before.txt"
  fi
done
```

백업을 확인하고 위치를 기록합니다. `nearby-interaction.js`와
`world/footbridge.js`는 신규 파일이므로 기존에 없어도 정상입니다. 다른 파일이
없거나 백업에 실패했다면 배포 위치를 확인하고 복사를 진행하지 않습니다.

## 3. 소유자 서버만 중지·교체·시작

다음 블록은 명령 하나라도 실패하면 중단합니다. 실패하면 아래 복구 절차를 따릅니다.

```sh
(
  set -eu
  "$MP_OWNER_PY" "$MP_OWNER_CTL" stop
  for MP_REL in _site/index.html _site/src/main.js _site/src/nearby-interaction.js _site/src/world/footbridge.js _site/sw.js; do
    mkdir -p "$MP_OWNER_DIR/$(dirname "$MP_REL")"
    cp -p "$MP_UPDATE_STAGE/$MP_REL" "$MP_OWNER_DIR/$MP_REL"
  done
  cd "$MP_OWNER_DIR"
  shasum -a 256 -c "$MP_UPDATE_STAGE/SHA256SUMS"
  "$MP_OWNER_PY" "$MP_OWNER_CTL" start
)
```

설치된 다섯 파일 모두 `OK`여야 합니다. 시작 출력과 실제 리스닝 정보를 대조해
**현재 소유자 서버 포트**를 확인합니다. 이전 포트나 컨트롤러 포트로 가정하지 않습니다.

## 4. HTTP·저장 배치·화면 확인

```sh
MP_OWNER_PORT='확인한_소유자_서버_포트'
for MP_URL_PATH in /index.html /src/main.js /src/nearby-interaction.js /src/world/footbridge.js /sw.js; do
  curl --silent --show-error --fail --output /dev/null --write-out '%{http_code}\n' \
    "http://127.0.0.1:$MP_OWNER_PORT$MP_URL_PATH"
done
```

다섯 URL이 각각 **HTTP 200**인지 확인합니다. 기존 `--public-origin` 설정이
있으면 기존 비공개 HTTPS 주소 또는 정확한 `Host`를 사용하며 서버 설정은 유지합니다.

브라우저를 **새로고침**하고 같은 비밀번호로 로그인합니다. 저장된 레이아웃은
처음 로드할 때 기존 배치를 백업한 뒤 한 번 이관하여 다리를 추가합니다.
연결 지형의 위치·형태를 사용자 설정으로 바꾼 경우 이관이 생략될 수 있습니다.
다리가 보이지 않으면 자동 이관의 적용·생략 여부를 확인하고, 저장 배치를 지워서
해결하려 하지 않습니다. 이 브라우저 배치 백업은 2단계 서버 파일 백업과 별개입니다.

1. 산책 모드에서 남쪽 섬과 율의 집 쪽 마을을 다리로 **걸어서 왕복**합니다.
   양 끝 진입, 다리 위 이동, 율의 집 문 앞 접근과 `F 입장`을 확인합니다.
2. 가까운 주민의 이름과 `F 말 걸기` 안내를 확인하고 F로 해당 화면을 엽니다.
   닫은 뒤 한글 입력 상태의 **ㄹ**로도 같은 동작을 확인합니다.
3. 입력란이나 열린 패널에서 F가 다른 주민 화면을 열지 않는지 확인합니다.
   기존 집 입장과 배의 `F 승선`·`F 하선`도 확인합니다.

적용 결과에는 백업 위치, 설치 해시, 현재 포트, 다섯 HTTP 상태, 저장 배치 이관
적용·생략, 다리 왕복 및 F·ㄹ·집·배 검증 결과를 기록합니다. 비밀번호·인증키는
기록하지 않습니다. HTTP 200만으로 실제 보행까지 검증했다고 표시하지 않습니다.

## 개발 환경 확인 결과

- 브라우저 전체 QA 결과 `pass`: 기존 집 접근, 도로, 배 승하선과 항구 이동 포함.
- 신규 다리 길이 약 14.29 세계 단위. 실제 이동 함수를 이용해 다리를 183걸음으로
  건너고, 19걸음 더 이동해 율의 집 문 앞에 도착한 뒤 202걸음으로 돌아왔습니다.
  이동 중 순간이동이나 물 충돌 해제를 사용하지 않았습니다.
- 물 위 40개 중심선 표본의 보행 허용, 양쪽 길 연결과 장애물 여유를 확인했습니다.
  화물선을 피해 동쪽으로 굽은 경로이며, 행성 곡면을 따르는 판자와 난간을 사용합니다.
- 별도 로컬 미리보기에서 확인한 결과입니다. 실제 Mac mini 배포는 위 절차로
  진행해야 합니다.

## 실패 시 복구

`"$MP_OWNER_PY" "$MP_OWNER_CTL" stop`으로 소유자 서버만 중지하고 백업 파일을
같은 경로에 복원합니다. `absent-before.txt`에 기록된 신규 파일만 제거한 뒤
`"$MP_OWNER_PY" "$MP_OWNER_CTL" start`로 시작하고 포트·HTTP 상태를 다시 확인합니다.
파일 복구는 브라우저에 저장된 레이아웃을 되돌리지 않으므로, 배치 문제는 이관 전
브라우저 배치 백업을 별도로 확인합니다. 전체 `_site`나 저장 배치를 삭제하지 않습니다.
