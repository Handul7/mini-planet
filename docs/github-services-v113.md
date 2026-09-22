# v113 공개 GitHub 프로젝트 안내

확인일: 2026-09-12. 공개 저장소 목록, README 또는 기능 문서, 등록된 홈페이지와 GitHub 배포 기록을 확인했습니다. 비공개 저장소와 개인 서비스 주소는 공개 데이터에 포함하지 않았습니다.

## 집별 연결

| 안내 위치 | 프로젝트 | 공개 연결 |
| --- | --- | --- |
| 로디 | Mini Planet | 현재 서비스 설명과 GitHub 소스 |
| 자비스 | 오늘 날씨 검색 | Vercel 웹 실행과 GitHub 소스 |
| 율 | 안심드라이브 (TeamJ) | 모바일 화면 프로토타입 설명과 GitHub 소스 |
| 루드비히 | Hermes Local Lab | GitHub Pages 가이드와 GitHub 소스 |
| 앤 | KYOBODT 사진관 | 증명사진 검사·변환 기능과 GitHub 설치 문서 |
| 아르고스 | Open-Meteo 날씨 실험실 | Python·Flask 프로젝트 설명과 GitHub 소스 |

집 배정은 안내 위치입니다. 해당 에이전트가 실제 서비스를 운영하거나 GitHub에 작업 결과를 자동 전송한다는 의미는 아닙니다. 기존 에이전트 상태·결과는 정적 샘플을 유지합니다.

## 확인한 근거

- [Hermes Local Lab README](https://github.com/Handul7/hermes-local-lab#readme): 로컬 AI 도구 선택, 개인 설치 목록, 기기·원격 운영 가이드. [공개 웹](https://handul7.github.io/hermes-local-lab/)의 설치 계획 화면 확인.
- [날씨 기능 문서](https://github.com/Handul7/weather_service/blob/main/WEATHER_WEB.md): 위치 검색, 시간별 예보, 기온 그래프. [공개 웹](https://weather-service-kappa.vercel.app/)에서 서울 결과·요약·시간별 표 확인.
- [TeamJ README](https://github.com/Handul7/TeamJ#readme): 가족 안심 운전 서비스의 정적 모바일 화면 시제품. Pages와 배포 기록에서 공개 실행 주소를 확인하지 못했습니다. 실시간 추적 서비스로 표현하지 않았습니다.
- [KYOBODTPROFILE README](https://github.com/Handul7/KYOBODTPROFILE#readme): 사진 적합성 확인과 증명사진 변환. 별도 서버·AI 설정이 필요합니다. 공개 실행 주소는 확인하지 못했습니다. 비밀번호·키·내부 주소는 복사하지 않았습니다.
- [Open-Meteo 기능 문서](https://github.com/Handul7/open-meteo-weather-web/blob/main/WEATHER_WEB.md): weather_service와 같은 내용의 문서입니다. 저장소가 동일하다고 단정하지 않았고, 별도 실행 서비스로 중복 안내하지 않았습니다.
- [Mini Planet](https://github.com/Handul7/mini-planet): 현재 제공 중인 행성 대시보드. 같은 서비스를 다시 여는 버튼은 숨기고 소스 링크를 제공합니다.

## 구현과 유지 관리

- `config/services.json`: 이름, 설명, 기능 목록, 실행 주소, 저장소, 공개 상태, 확인 날짜를 관리합니다.
- 집 패널에서 프로젝트를 바꿀 수 있으며 최근 결과 탭은 기존대로 유지합니다.
- 외부 링크는 새 탭에서 열고 `noopener noreferrer`를 사용합니다. 사진 업로드, 계정 연동, API 호출은 미니플래닛에 추가하지 않았습니다.
- 페이지를 열 때 외부 프로젝트를 일괄 조회하지 않습니다. 기존 불투명한 no-cors 응답을 온라인 성공으로 처리하던 검사를 제거했습니다.
- 공개 주소는 인증 정보 없는 HTTPS 도메인만 허용합니다. 개인 주소는 기존 로컬 설정에만 남습니다.
- `publicPreview=1`은 로컬 접속에서도 개인 연결 파일을 불러오지 않고 공개 설정을 검증하는 옵션입니다. 공개 사이트에서 개인 연결을 활성화할 수는 없습니다.
- 공개 실행 주소를 나중에 확보하면 해당 항목의 `url`, `availability`, `checkedAt`, `note`를 갱신하면 됩니다. GitHub 목록을 자동 동기화하는 기능은 이번 범위에 없습니다.

## 검증 결과

- 전체 자동 테스트 202개 통과. 신규 6개 검사에서 공개 URL 제한, 악성 문자열의 텍스트 처리, 프로젝트 전환 시 이전 링크 제거, 로컬 설정 경계와 캐시 포함을 확인했습니다.
- 집 6곳의 서비스 입구·패널·최근 결과 공간과 기존 행성 통합 검사 통과.
- PC와 390px·320px 모바일 화면에서 서비스 패널 확인. 320px 화면에서 페이지와 패널의 가로 넘침 없음.
- 여섯 프로젝트의 제목·공개 상태·기능 3개·GitHub 링크 확인. 실행 버튼은 확인된 두 외부 서비스에만 표시됩니다.
- 공개 배포 파일 경계 검사 통과. 공개 파일 90개, 약 3.54 MiB이며 개인 연결 파일은 제외됩니다.

행성 배치, 집 에셋, 보행·배 이동은 변경하지 않았습니다. 이 문서 작성 시점에는 커밋·원격 배포를 수행하지 않았습니다.
