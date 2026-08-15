# EntryMerge — 엔트리 작품 합치기

엔트리(Entry) 작품 파일(`.ent`)을 합쳐주는 크롬 확장프로그램입니다. 서버를 거치지 않고 브라우저에서 바로 처리해 안전합니다.

웹 버전과 병합 계약을 공유하지만 실행 경로는 독립적입니다. 확장판은 브라우저 로컬에서
처리하고, 웹 버전 `entry.205.kr`은 2026-08-16부터 Oracle Cloud VM에서 운영합니다.

## 설치
- **Chrome Web Store**: https://chromewebstore.google.com/detail/entrymerge-%EC%97%94%ED%8A%B8%EB%A6%AC-%EC%9E%91%ED%92%88-%ED%95%A9%EC%B9%98%EA%B8%B0/afkojcdofphbphfalnjgidbefbmndgjm

## 주요 기능
- `.ent` 파일 2~10개를 하나로 합치기
- 장면·오브젝트·변수·리스트·신호·함수·표의 ID를 namespace별로 재발급해 충돌 방지
- 블록 AST를 순회해 참조를 정확히 갱신(무차별 문자열 치환 없음)
- 출력 검증에 실패하면 병합을 중단(깨진 작품을 내보내지 않음)
- 드래그 앤 드롭 파일 선택
- 리메이크 출처를 기존 기본 작품, 숨기기, 합친 작품 중 하나로 선택
- 대답·초시계 변수 숨기기 옵션

## 구조

| 파일 | 역할 |
| --- | --- |
| `js/merge-core.js` | 병합 알고리즘(ID 재발급·AST 참조 갱신·스키마 병합·검증) |
| `js/merge-engine.js` | gzip/TAR 해체·조립, 진행률 보고 |
| `js/tar.js` | TAR 파서·생성기(읽기 PAX/GNU 확장 헤더, 쓰기 USTAR) |
| `js/app.js` | 파일 선택 UI |

병합 알고리즘은 웹 버전과 공유하는 명세를 따른다:
[`ent-merge-spec.md`](https://github.com/205sla/EntryMergeServer/blob/main/docs/ent-merge-spec.md).
한쪽을 고치면 반대쪽도 같은 작업에서 고친다.

## 사용 방법
1. 확장프로그램 아이콘 클릭
2. 합치려는 `.ent` 파일 2개 이상을 드래그하거나 선택
3. **작품 합치기** 버튼 → 합쳐진 파일이 다운로드됨

## 제한
- 파일당 최대 50MB / 전체 150MB / 최대 10개

## 회귀 테스트

```bash
node --test
```

현재 표·checker 블록 참조, 참조 기준선, 리소스 `thumbUrl`, ID 발급 상한과
Gzip/TAR 경로·항목 안전 정책을 검사한다.

병합 계약 하드닝 변경은 `codex/merge-contract-hardening` 브랜치와
[GitHub PR #1](https://github.com/205sla/EntryMerge-Extension/pull/1)에서 검토한다.

## 관련 링크
- 웹 버전: https://entry.205.kr
- 서버 코드: https://github.com/205sla/EntryMergeServer
- 문의: 205@205.kr
