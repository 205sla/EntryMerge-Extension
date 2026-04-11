# Chrome Web Store 등록 정보

---

## 1. 항목 세부정보 (Item Details)

**확장프로그램 이름 (Extension name):**
```
EntryMerge - 엔트리 작품 합치기
```

**요약 설명 (Summary, 132자 이내):**
```
엔트리(Entry) 작품 파일(.ent)을 합쳐주는 도구입니다. 서버 없이 브라우저에서 바로 합칠 수 있습니다.
```

**설명 (Description):**
```
엔트리(playentry.org) 작품 파일(.ent)을 하나로 합쳐주는 무료 도구입니다.

합작 작품을 만들 때, 여러 명이 각자 만든 엔트리 작품을 하나의 파일로 합쳐야 할 때 사용합니다.

◆ 주요 기능
• .ent 파일 2~10개를 하나로 합치기
• 드래그 앤 드롭으로 간편한 파일 선택
• 서버 없이 내 컴퓨터에서 바로 처리 (개인정보 안전)
• 리메이크 표시 지우기 옵션
• 대답/초시계 변수 숨기기 옵션

◆ 사용 방법
1. 확장프로그램 아이콘을 클릭합니다.
2. 합치려는 .ent 파일 2개 이상을 드래그하거나 선택합니다.
3. "작품 합치기" 버튼을 클릭하면 합쳐진 파일이 다운로드됩니다.

◆ 제한 사항
• 파일당 최대 50MB
• 전체 최대 150MB
• 최대 10개 파일

◆ 개인정보 보호
모든 파일 처리는 브라우저 내에서 로컬로 수행됩니다.
파일이 외부 서버로 전송되지 않습니다.

문의: 205@205.kr
웹 버전: https://entry.205.kr
GitHub: https://github.com/205sla/EntryMergeServer
```

**카테고리 (Category):**
```
생산성 (Productivity)
```

**언어 (Language):**
```
한국어 (Korean)
```

---

## 2. 개인정보처리방침 (Privacy Policy)

> Chrome Web Store 등록 시 "개인정보처리방침 URL" 필드에 아래 내용을 게시한 페이지 URL을 입력합니다.
> GitHub 레포지토리의 PRIVACY.md 또는 별도 페이지를 사용할 수 있습니다.

```
EntryMerge 개인정보처리방침

최종 수정일: 2025년 1월 18일

1. 수집하는 개인정보
본 확장프로그램은 사용자의 개인정보를 일체 수집하지 않습니다.

2. 데이터 처리 방식
• 사용자가 선택한 .ent 파일은 브라우저 내에서만 처리됩니다.
• 파일 데이터는 외부 서버로 전송되지 않습니다.
• 처리 완료 후 파일 데이터는 메모리에서 즉시 해제됩니다.

3. 외부 서비스 연동
본 확장프로그램은 어떠한 외부 서비스, 분석 도구, 광고 네트워크와도 연동되지 않습니다.

4. 쿠키 및 저장소
본 확장프로그램은 쿠키, localStorage, 또는 기타 브라우저 저장소를 사용하지 않습니다.

5. 문의
개인정보 관련 문의: 205@205.kr


EntryMerge Privacy Policy

Last updated: January 18, 2025

This extension does not collect, store, or transmit any personal data.
All file processing is performed entirely within the user's browser.
No data is sent to external servers.
No cookies, localStorage, or other browser storage mechanisms are used.
No analytics, tracking, or advertising services are integrated.

Contact: 205@205.kr
```

---

## 3. 권한 근거 (Permissions Justification)

> Chrome Web Store 제출 시 "단일 용도 설명(Single purpose description)" 필드에 입력합니다.

```
이 확장프로그램의 단일 목적은 엔트리(.ent) 작품 파일을 합치는 것입니다.
추가 권한을 요청하지 않으며, 파일 읽기는 사용자가 직접 선택한 파일에 한하여 표준 File API를 통해 수행됩니다.
```

---

## 4. 스토어 그래픽 에셋 체크리스트

| 항목 | 사양 | 파일 |
|------|------|------|
| 아이콘 | 128x128 PNG | `icons/icon128.png` (제출 패키지에 포함) |
| 스크린샷 | 1280x800 또는 640x400, JPEG/PNG, 1~5장 | (직접 촬영 필요) |
| 프로모션 타일 (소) | 440x280 PNG (선택) | (필요 시 제작) |
| 프로모션 타일 (대) | 920x680 PNG (선택) | (필요 시 제작) |
| 마키 프로모션 타일 | 1400x560 PNG (선택) | (필요 시 제작) |

---

## 5. 제출 패키지 만들기

확장프로그램 폴더를 ZIP으로 압축하여 제출합니다.
STORE_LISTING.md는 제출 패키지에서 제외해도 됩니다.

포함할 파일:
```
manifest.json
background.js
merge.html
css/style.css
js/pako.min.js
js/tar.js
js/merge-engine.js
js/app.js
icons/icon16.png
icons/icon48.png
icons/icon128.png
```

ZIP 생성 명령어 (PowerShell):
```powershell
Compress-Archive -Path manifest.json, background.js, merge.html, css, js, icons -DestinationPath EntryMerge.zip
```
